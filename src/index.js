'use strict';

var assert = require('assert');
var KoaRouter = require('koa-router');
var methods = require('methods');
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
  produces: [
    'application/json',
    'text/plain; charset=utf-8'
  ],
  schemes: [
    'http'
  ],
  basePath: '/',
  host: 'localhost'
};

var log = function() {
  console.log.apply(null, Array.prototype.slice.call(arguments)
    .map(arg => JSON.stringify(arg, null, '  ')));
};

const onSuccess = {
  200: {
    description: 'Success'
  }
};

const onError = {
  400: {
    description: 'Error'
  }
};

var methodsData = new WeakMap();

class Method {
  constructor(spec, path, method) {

    var match = path.match(/^\/(\w*)\/?/);
    let prefix;
    assert(match && (prefix = match[1]),
      `Path ${path} should be int format /path or /path/anything`);

    Object.assign(spec, {
      tags: [prefix],
      summary: titleCase(`${method} ${prefix}`),
      description: '',
      responses: Object.assign({}, onSuccess, onError)
    });

    methodsData.set(this, {spec, onSuccess, onError});

  }

  tags(tags) {
    methodsData.get(this).spec.tags = toArray(tags);
    return this;
  }

  params(params) {
    methodsData.get(this).spec.parameters = toArray(params)
      .map(param => toSpecParam(param));
    return this;
  }

  onSuccess(response, status) {
    var data = methodsData.get(this);
    if (containsStatus(response)) {
      data.onSuccess = toSpecResponses(response);
    } else {
      data.onSuccess = toSpecResponses({[status || 200]: response});
    }
    data.spec.responses = Object.assign({}, data.onSuccess, data.onError);
    return this;
  }

  onError(response, status) {
    var data = methodsData.get(this);
    if (containsStatus(response)) {
      data.onError = toSpecResponses(response);
    } else {
      data.onError = toSpecResponses({[status || 400]: response});
    }
    data.spec.responses = Object.assign({}, data.onSuccess, data.onError);
    return this;
  }
}

var specsData = new WeakMap();

class Spec {
  constructor(spec) {
    let it = {};
    it.spec = Object.assign({}, defaultSpec, spec);
    it.spec.paths = spec && spec.paths || {};
    it.spec.definitions = spec && spec.definitions || {}
    specsData.set(this, it);
  }

  addDefinition(name, definition) {
    let it = specsData.get(this);
    if (it.spec.definitions[name]) {
      throw new Error('Definition "' + name + '" already exists');
    }
    it.spec.definitions[name] = toJsonSchema(definition);
  }

  addMethod(path, method) {
    let it = specsData.get(this);
    path = path.replace(/\:(\w*)/g, (match, name) => `{${name}}`);
    it.spec.paths[path] = it.spec.paths[path] || {};
    assert(it.spec.paths[path][method] === void 0, `Method ${method} already defined for path ${path}`);
    return new Method(it.spec.paths[path][method] = {}, path, method);
  }

  get() {
    return specsData.get(this).spec;
  }

}

var routersData = new WeakMap();

class Router {

  constructor(spec) {
    routersData.set(this, {
      spec: new Spec(spec),
      router: new KoaRouter()
    });
  }

  get spec() {
    return routersData.get(this).spec;
  }

  routes() {
    return routersData.get(this).router.routes();
  }

}

methods.forEach(function(method) {
  Router.prototype[method] = function(path, middleware) {
    let it = routersData.get(this);
    let specMethod = it.spec.addMethod(path, method, middleware);
    it.router[method](path, function*(next) {
      try {
        yield *middleware.call(this, next);
      } catch (error) {
        this.status = error.status || 500;
        if (this.status < 500) {
          this.body = error;
        }
        this.app.emit('error', error, this);
      }
    });
    return specMethod;
  };
});

function toArray(any) {
  return any ? Array.isArray(any) ? any : [any] : [];
}

function toSpecParam(param) {
  let specParam = {};
  specParam.in = param.in || 'query';
  specParam.name = param.name;
  specParam.description = param.description || '';
  specParam.required = specParam.in === 'path' ? true : param.required === true || false;
  if (param.schema) {
    specParam.schema = typeof param.schema === 'string' ? {
      $ref: `#/definitions/${param.schema}`
    } : param.schema;
    if (param.type === 'array') {
      specParam.items = specParam.schema;
      delete specParam.schema;
    }
  } else {
    specParam.type = param.type || 'string';
  }
  if (param.format) {
    specParam.format = param.format;
  }
  return specParam;
}

function toSpecResponses(responses) {
  Object.keys(responses)
    .forEach(status => {
      let response = responses[status];
      if (typeof response.schema === 'string') {
        response.schema = {
          $ref: `#/definitions/${response.schema}`
        };
      }
      if (typeof response.items === 'string') {
        response.schema = {
          type: 'array',
          items: {
            $ref: `#/definitions/${response.items}`
          }
        };
        delete response.items;
      }
      response.description = response.description || '';
    });
  return responses;
}

function containsStatus(response) {
  return Object.keys(response)
    .reduce((res, key) => res === false ? res : !isNaN(key), true);
}

function toJsonSchema(schema, level) {
  level = level || 0;
  let definition = {};
  Object.keys(schema).forEach(function(key) {
    var value = schema[key];
    if (level === 0) {
      if (['properties', 'title', 'description', 'type']
          .indexOf(key) === -1) {
        key = 'x-' + key;
      }
    } else {
      if (['properties', 'title', 'description', 'type', 'schema', 'items']
          .indexOf(key) === -1) {
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
      if (['title', 'description', 'type', 'schema', 'properties',
          '$ref', 'maxLength', 'format', 'enum', 'items']
          .indexOf(key) === -1) {
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
            if (['type']
                .indexOf(key) === -1) {
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

module.exports = Router;
