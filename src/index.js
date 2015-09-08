'use strict';

var parse = require('co-body');
var assert = require('assert');
var yaml = require('js-yaml');
var router = require('koa-router')();
var fs = require('fs');
var path = require('path');
var findUp = require('findup-sync');
var titleCase = require('title-case');

var pack = require(findUp('package.json', {
  cwd: path.dirname(module.parent.filename)
}));

var log = console.log;

module.exports = function(spec) {

  let resources = [];
  spec = load(spec || path.join(__dirname, 'spec.yaml'));
  spec.info.description = spec.info.description || pack.description;
  spec.info.version = spec.info.version || pack.version;
  spec.info.title = spec.info.title || titleCase(pack.name);
  spec.info.contact.name = spec.info.contact.name ||
    (pack.author && pack.author.name);
  spec.info.license.name = spec.info.license.name ||
    (pack.private === true ? 'private' : pack.license);
  spec.paths = spec.paths || {};
  spec.definitions = spec.definitions || {};

  return {

    add: function(prefix, api, methods, definitions) {

      Object.keys(definitions || {}).forEach(function(key) {
        spec.definitions[key] = definitions[key];
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
          description: action.description,
          operationId: action.operation.name,
          consumes: [],
          produces: [],
          responses: []
        };
        specMethod.tags = specMethod.tags.concat(toArray(action.tags));
        specMethod.parameters = action.operation.params.map(function(param) {
          return createSpecParam('path', param, {
              knownNames: pathParams,
              required: true
            }) ||
            createSpecParam('body', param) ||
            createSpecParam('query', param, {knownNames: [param.name]}); // default, always last
        });

        router[method](path, function*() {

          let args = [];
          for (var i = 0; i < specMethod.parameters.length; i++) {
            var param = specMethod.parameters[i];
            if (param.in === 'path') {
              args.push(this.params[param.name]);
            } else if (param.in === 'body') {
              let body = yield parse(this);
              if (param.name === 'body') {
                args.push(body);
              } else {
                args.push(body[param.name]);
              }
            } else if (param.in === 'query') {
              args.push(this.query[param.name]);
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
          if (result === void 0) {
            this.status = 404;
          } else {
            this.body = result;
            if (action.response && action.response.status) {
              this.status = action.response.status;
            }
          }
        });
      });
      log('spec', JSON.stringify(spec, null, ' '))
    },
    routes: function() {
      return router.routes();
    }
  };
};

function load(spec) {
  if (typeof spec === 'string') {
    let extname = path.extname(spec);
    if (extname === '.yaml' || extname === '.yml') {
      return yaml.load(fs.readFileSync(spec));
    } else if (extname === '.json' || extname === '.js') {
      return require(spec);
    } else {
      throw new Error('File "' + spec + '" is invalid');
    }
  }
  return spec;
}

function match(str, re) {
  if (!re.global) {
    return str.match(re).slice(1);
  }
  var res = [];
  var m;
  while ((m = re.exec(str)) !== null) {
    if (m.index === re.lastIndex) {
      re.lastIndex++;
    }
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
      specParam.schema = {
        $ref: `#/definitions/${param.schema}`
      };
    } else if (param.name === searchIn) {
      specParam.type = param.type || 'object';
    } else {
      specParam.type = param.type || 'string';
    }
    specParam.format = param.format;
    return specParam;
  }
}
