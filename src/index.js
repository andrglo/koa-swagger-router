'use strict';

var assert = require('assert');
var KoaRouter = require('koa-router');
var co = require('@ayk/co');
var parseBody = require('co-body');
var methods = require('methods');
var extend = require('deep-extend');
var path = require('path');
var findUp = require('findup-sync');
var titleCase = require('title-case');
var jsonRefs = require('json-refs');

const onSuccess = [
  {
    200: {
      description: 'Success'
    }
  }
];

const onError = [
  {
    400: {
      description: 'Error'
    }
  }
];

var methodsData = new WeakMap();

class Method {
  constructor(spec, path, method, parent) {

    var match = path.match(/^\/(\w*)\/?/);
    let prefix;
    assert(match && (prefix = match[1]),
      `Path ${path} should be int format /path or /path/anything`);

    Object.assign(spec, {
      tags: [prefix],
      summary: titleCase(`${method} ${prefix}`),
      description: '',
      responses: Object.assign({}, onSuccess[0], onError[0]),
      security: [{ internalApiKey: [] }]
    });

    methodsData.set(this, { spec, onSuccess, onError, parent });

  }

  tags(tags) {
    methodsData.get(this).spec.tags = toArray(tags);
    return this;
  }

  summary(summary) {
    methodsData.get(this).spec.summary = summary;
    return this;
  }

  description(description) {
    methodsData.get(this).spec.description = description;
    return this;
  }

  security(value) {
    methodsData.get(this).spec.security = value;
    return this;
  }

  get spec() {
    return methodsData.get(this).spec;
  }

  params(params) {
    this.bodyRequested = false;
    methodsData.get(this).spec.parameters = toArray(params)
      .map(param => {
        if (param.in === 'body') {
          this.bodyRequested = true;
        }
        return toSpecParam(param);
      });
    return this;
  }

  onSuccess(response) {
    var data = methodsData.get(this);
    data.onSuccess = [];
    toArray(response)
      .forEach(response => data.onSuccess.push(toSpecResponse(data.parent, response, 200)));
    data.spec.responses = Object.assign({},
      data.onSuccess.reduce((result, response) => Object.assign(result, response), {}),
      data.onError.reduce((result, response) => Object.assign(result, response), {}));
    return this;
  }

  onError(response) {
    var data = methodsData.get(this);
    data.onError = [];
    toArray(response)
      .forEach(response => data.onError.push(toSpecResponse(data.parent, response, 400)));
    data.spec.responses = Object.assign({},
      data.onSuccess.reduce((result, response) => Object.assign(result, response), {}),
      data.onError.reduce((result, response) => Object.assign(result, response), {}));
    return this;
  }

  successStatuses() {
    var data = methodsData.get(this);
    return data.onSuccess.map(response => Number(Object.keys(response)[0]));
  }

  errors() {
    var data = methodsData.get(this);
    return data.onError.map(response => ({
      status: Number(Object.keys(response)[0]),
      name: response[Object.keys(response)[0]].name,
      show: response[Object.keys(response)[0]].show,
      catch: response[Object.keys(response)[0]].catch || []
    }));
  }
}

var specsData = new WeakMap();

class Spec {
  constructor(options) {
    options = options || {};

    let spec = options.spec;

    /*eslint-disable*/
    let dirname = options.__dirname;
    /*eslint-enable*/

    var pack = require(findUp('package.json', {
      cwd: dirname || path.dirname(module.parent.filename)
    }));

    let it = {};
    it.spec = extend({
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
        'https'
      ],
      securityDefinitions: {
        internalApiKey: {
          type: 'apiKey',
          name: 'api_key',
          in: 'header'
        }
      }
    }, spec);

    it.spec.paths = spec && spec.paths || {};
    it.spec.definitions = spec && spec.definitions || {};
    specsData.set(this, it);
  }

  setBasePath(basePath) {
    let it = specsData.get(this);
    it.spec.basePath = basePath;
  }

  addDefinition(name, definition) {
    let it = specsData.get(this);
    it.spec.definitions[name] = toJsonSchema(definition);
  }

  addMethod(path, method) {
    let it = specsData.get(this);
    path = path.replace(/\:(\w*)/g, (match, name) => `{${name}}`);
    it.spec.paths[path] = it.spec.paths[path] || {};
    assert(it.spec.paths[path][method] === void 0, `Method ${method} already defined for path ${path}`);
    return new Method(it.spec.paths[path][method] = {}, path, method, this);
  }

  get() {
    return specsData.get(this).spec;
  }

}

var routersData = new WeakMap();

class Router {

  constructor(options) {
    options = options || {};
    let prefix = options.prefix;
    let router = new KoaRouter();
    let spec = new Spec(options);
    routersData.set(this, { prefix, spec, router });
  }

  param() {
    var router = routersData.get(this).router;
    return router.param.apply(router, arguments);
  }

  use() {
    var router = routersData.get(this).router;
    return router.use.apply(router, arguments);
  }

  allowedMethods() {
    var router = routersData.get(this).router;
    return router.allowedMethods.apply(router, arguments);
  }

  get spec() {
    return routersData.get(this).spec;
  }

  userSpec() {
    const it = routersData.get(this);
    return function*() {
      let spec = yield stripNotAuthorizedActions.call(this, it.prefix, it.spec.get());
      spec.host = this.host;
      const definition = this.query.definition;
      if (definition) {
        if (definition in spec.definitions) {
          this.body = spec.definitions[definition];
        }
      } else {
        this.body = spec;
      }
    };
  }

  routes() {
    this
      .get('/spec', this.userSpec())
      .params({
        in: 'query',
        name: 'definition',
        description: 'Fetch only the requested definition'
      })
      .onSuccess({
        description: 'A swagger specification or definition'
      });
    return routersData.get(this).router.routes();
  }

}

function normalizeResource(prefix, resource) {
  resource = resource.replace(/\:(\w*)/g, () => '*');
  return prefix ? `/${prefix}${resource}` : `${resource}`;
}

function* stripNotAuthorizedActions(prefix, spec) {

  let strip = function*() {
    spec = Object.assign({}, spec);

    let paths = {};
    let pathsKeys = Object.keys(spec.paths);
    for (let i = 0; i < pathsKeys.length; i++) {
      let path = pathsKeys[i];
      let methods = {};
      let methodsKeys = Object.keys(spec.paths[path]);
      for (let j = 0; j < methodsKeys.length; j++) {
        let method = methodsKeys[j];
        try {
          yield this.state.authorize.call(this, method, normalizeResource(prefix, path), spec.paths[path][method]);
          methods[method] = spec.paths[path][method];
        } catch (error) {
          if (error.status !== 403) {
            throw error;
          }
        }
      }
      if (Object.keys(methods).length) {
        paths[path] = methods;
      }
    }

    let definitions = {};
    var refs = jsonRefs.findRefs(paths);
    Object.keys(refs).forEach(key => {
      let values = jsonRefs.pathFromPtr(refs[key].uri);
      let definition = values[1];
      definitions[definition] = spec.definitions[definition];
    });

    spec.paths = paths;
    spec.definitions = definitions;
    return spec;
  }.bind(this);

  return !this.state.authorize ? spec : yield strip();
}

methods.forEach(function(method) {
  Router.prototype[method] = function(path, middleware) {
    let it = routersData.get(this);
    let thisMethod = it.spec.addMethod(path, method);
    const normalizedResource = normalizeResource(it.prefix, path);
    const thisMethodSpec = thisMethod.spec;
    it.router[method](path, function*(next) {
      try {
        if (this.state.authorize) {
          yield this.state.authorize.call(this, method, normalizedResource, thisMethodSpec);
        }
        if (thisMethod.bodyRequested) {
          this.state.body = yield parseBody(this);
        }
        yield co(middleware.call(this, this, this.state, next));
        if (this.body !== void 0) {
          let successStatus = thisMethod.successStatuses();
          if (successStatus.indexOf(this.status) === -1) {
            this.status = successStatus[0];
          }
        }
      } catch (e) {
        this.status = e.status || 500;
        let errors = thisMethod.errors();
        let caught = false;
        errors.forEach(error => {
          error.catch.forEach(fn => {
            if (!caught && (typeof fn === 'string' ? fn === e.name : fn(e))) {
              this.status = error.status;
              this.body = error.show(e, this);
              caught = true;
            }
          });
        });
        this.app.emit('error', e, this);
      }
    });
    return thisMethod;
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
  } else if (['date', 'datetime', 'time'].indexOf(param.type) !== -1) {
    specParam.type = 'string';
  } else {
    specParam.type = param.type || 'string';
  }
  if (param.format) {
    specParam.format = param.format;
  }
  return specParam;
}

function toSpecResponse(spec, response, status) {
  let specResponse = {};
  let statusObject = specResponse[response.status || status] = {};
  Object.defineProperty(statusObject, 'name', {
    value: response.name,
    writable: true
  });
  if (typeof response.schema === 'string') {
    statusObject.schema = {
      $ref: `#/definitions/${response.schema}`
    };
    statusObject.name = response.name || response.schema;
  } else if ('schema' in response) {
    if (response.name) {
      spec.addDefinition(response.name, response.schema);
      statusObject.schema = {
        $ref: `#/definitions/${response.name}`
      };
    } else {
      statusObject.schema = response.schema;
    }
  }
  if (typeof response.items === 'string') {
    statusObject.schema = {
      type: 'array',
      items: {
        $ref: `#/definitions/${response.items}`
      }
    };
    statusObject.name = response.name || response.schema;
    delete response.items;
  }
  statusObject.description = response.description || (status >= 400 ? 'Error' : 'Success');
  if (status >= 400) {
    Object.defineProperty(statusObject, 'show', {
      value: response.show || (error => ({ message: error.message }))
    });
    Object.defineProperty(statusObject, 'catch', {
      value: response.catch || [statusObject.name]
    });
  }
  return specResponse;
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
    if (['date', 'datetime', 'time'].indexOf(property.type) !== -1) {
      property.format = property.type;
      property.type = 'string';
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
      } else if (property.schema) {
        let schema = {};
        if (property.schema.$ref) {
          schema['x-$ref'] = property.schema.$ref;
        }
        if (property.schema.key) {
          schema['x-key'] = property.schema.key;
        }
        property['x-schema'] = schema;
        delete property.schema;
      } else if (property.$ref) {
        property['x-$ref'] = property.$ref;
        delete property.$ref;
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
