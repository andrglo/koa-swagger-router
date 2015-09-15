'use strict';

var parse = require('co-body');
var assert = require('assert');
var router = require('koa-router')();
var fs = require('fs');
var path = require('path');
var findUp = require('findup-sync');
var titleCase = require('title-case');

var pack = require(findUp('package.json', {
  cwd: path.dirname(module.parent.filename)
}));

var defaultSpec = {
  swagger: '2.0',
  info: {
    title: titleCase(pack.name),
    description: pack.description,
    version: pack.version,
    contact: {
      name: pack.author && pack.author.name
    },
    license: {
      name: pack.private === true ? 'Proprietary' : pack.license
    }
  },
  basePath: '/',
  host: 'localhost'
};

//var log = function(name, obj) {
//  console.log(name);
//  console.dir(obj, {
//    showHidden: true,
//    depth: null,
//    colors: true
//  });
//};

module.exports = function(spec) {

  spec = Object.assign({}, defaultSpec, spec);
  spec.paths = spec.paths || {};
  spec.definitions = spec.definitions || {};

  return {

    add: function(prefix, api, methods, schemas) {

      Object.keys(schemas || {}).forEach(function(key) {
        if (spec.definitions[key]) {
          throw new Error('Schema "' + key + '"already exists');
        }
        spec.definitions[key] = toJsonSchema(schemas[key]);
      });

      let keys = Object.keys(methods);
      keys.forEach(function(key) {
        let action = methods[key];
        let keyInfo = match(key, /(^\w*) ?(.*)/);
        let method = keyInfo[0].toLowerCase();
        let path = `/${prefix}`;
        if (keyInfo[1]) {
          path += `/${keyInfo[1]}`;
        }
        let pathParams = match(path, /\:(\w*)/g);

        let specPath = path.replace(/\:(\w*)/g, function(match, name) {
          return `{${name}}`;
        });
        assert(action.operation, 'Operation not informed');
        assert(action.operation.name, 'Operation name not informed');
        assert(action.operation.params, 'Operation params not informed');
        spec.paths[specPath] = spec.paths[specPath] || {};
        let specMethod = spec.paths[specPath][method] = {
          tags: [prefix],
          summary: action.summary || titleCase(`${method} ${prefix}`),
          description: action.description || '',
          responses: {}
        };
        specMethod.tags = specMethod.tags.concat(toArray(action.tags));
        specMethod.parameters = action.operation.params.map(function(param) {
          return createSpecParam('path', param, {knownNames: pathParams, required: true}) ||
            createSpecParam('body', param) ||
            createSpecParam('query', param, {knownNames: [param.name]}); // default, always last
        });
        let response = action.response && action.response.status || 200;
        specMethod.responses[response] = {
          description: 'Success'
        };
        specMethod.consumes = action.consumes;
        specMethod.produces = action.produces;
        specMethod.security = action.security;

        router[method](path, function*() {

          let args = [];
          let bodyAdded;
          let queryAdded;
          for (var i = 0; i < specMethod.parameters.length; i++) {
            var param = specMethod.parameters[i];
            if (param.in === 'path') {
              args.push(this.params[param.name]);
            } else if (param.in === 'body') {
              let body = yield parse(this);
              if (param.name === 'body') {
                if (!bodyAdded) {
                  args.push(body);
                  bodyAdded = true;
                }
              } else {
                args.push(body[param.name]);
              }
            } else if (param.in === 'query') {
              if (!queryAdded) {
                args.push(this.query);
                queryAdded = true;
              }
            }
          }
          if (action.operation.doBefore) {
            args = action.operation.doBefore.apply(this, args);
          }
          //todo check if it is a generator or a promise
          let promise = api[action.operation.name].apply(api, args);
          let result = yield promise;
          if (action.operation.doAfter) {
            result = action.operation.doAfter.call(this, result);
          }
          if (action.response && action.response.status) {
            this.body = result;
            this.status = action.response.status;
          } else if (result === void 0) {
            this.status = 404;
          } else {
            this.body = result;
          }
        });
      });
    },
    routes: function() {
      return router.routes();
    },
    spec: function() {
      return spec;
    }
  };
};

function match(str, re) {
  if (!re.global) {
    return str.match(re).slice(1);
  }
  var res = [];
  var m;
  while ((m = re.exec(str)) !== null) {
    //if (m.index === re.lastIndex) {
    //  re.lastIndex++;
    //}
    res.push(m[1]);
  }
  return res;
}

function toArray(any) {
  return any ? (Array.isArray(any) ? any : [any]) : [];
}

function createSpecParam(searchIn, param, options) {
  options = options || {};
  let knownNames = options.knownNames || [];
  var prefix = `${searchIn}.`;
  if (param.name === searchIn ||
    param.name.startsWith(prefix) ||
    knownNames.indexOf(param.name) !== -1) {
    let specParam = {};
    specParam.in = searchIn;
    specParam.name = param.name.replace(prefix, '');
    specParam.description = param.description;
    specParam.required = param.required === true || options.required === true;
    if (param.schema) {
      specParam.schema = typeof param.schema === 'string' ? {
        $ref: `#/definitions/${param.schema}`
      } : param.schema;
    } else if (param.name === searchIn) {
      specParam.type = param.type || 'object';
    } else {
      specParam.type = param.type || 'string';
    }
    specParam.format = param.format;
    return specParam;
  }
}

function toJsonSchema(schema, level) {
  level = level || 0;
  let definition = {};
  Object.keys(schema).forEach(function(key) {
    var value = schema[key];
    if (level === 0) {
      if ([
          'properties', 'title', 'description', 'type'
        ].indexOf(key) === -1) {
        key = 'x-' + key;
      }
    } else {
      if ([
          'properties', 'title', 'description', 'type', 'schema', 'items'
        ].indexOf(key) === -1) {
        key = 'x-' + key;
      }
    }
    switch (typeof value) {
      //case 'function':
      //  break;
      //case 'array':
      //  definition[key] = value.slice(0);
      //  break;
      case 'object':
        definition[key] = Object.assign({}, value);
        break;
      default:
        definition[key] = value;
    }
  });
  var required = [];
  Object.keys(definition.properties).forEach(function(key) {
    let source = definition.properties[key];
    if (source.required === true) {
      required.push(key);
    }
    let property = {};
    Object.keys(source).forEach(function(key) {
      if (key === 'required') {
        return;
      }
      var value = source[key];
      if ([
          'title', 'description', 'type', 'schema', 'properties',
          '$ref', 'maxLength', 'format', 'enum', 'items'
        ].indexOf(key) === -1) {
        key = 'x-' + key;
      }
      property[key] = value;
    });
    if (property.enum && property.maxLength) {
      delete property.maxLength;
    }
    if (property.type === 'object') {
      definition.properties[key] = toJsonSchema(property, level + 1);
    } else {
      if (property.type === 'array' && typeof property.items === 'object') {
        if (property.items.type === 'object') {
          property.items = toJsonSchema(property.items, level + 1);
        } else {
          property.items = {};
          Object.keys(source.items).forEach(function(key) {
            var value = source.items[key];
            if ([
                'type'
              ].indexOf(key) === -1) {
              key = 'x-' + key;
            }
            property.items[key] = value;
          });
        }
      }
      definition.properties[key] = property;
    }
  });
  if (required.length) {
    definition.required = required;
  }
  return definition;

}
