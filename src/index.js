const assert = require('assert')
const KoaRouter = require('koa-router')
const co = require('@ayk/co')
const parseBody = require('co-body')
const methods = require('methods')
const extend = require('deep-extend')
const path = require('path')
const findUp = require('findup-sync')
const titleCase = require('title-case')
const jsonRefs = require('json-refs')

const isGenerator = obj =>
  typeof obj.next === 'function' && typeof obj.throw === 'function'

const isGeneratorFunction = obj => {
  const constructor = obj.constructor
  if (!constructor) {
    return false
  }
  if (
    constructor.name === 'GeneratorFunction' ||
    constructor.displayName === 'GeneratorFunction'
  ) {
    return true
  }
  return isGenerator(constructor.prototype)
}

const onSuccess = [
  {
    200: {
      description: 'Success'
    }
  }
]

const onError = [
  {
    400: {
      description: 'Error'
    }
  }
]

const methodsData = new WeakMap()

class Method {
  constructor(spec, path, method, parent) {
    const match = path.match(/^\/(\w*)\/?/)
    let prefix
    assert(
        match && (prefix = match[1]),
        `Path ${path} should be int format /path or /path/anything`
    )

    Object.assign(spec, {
      tags: [prefix],
      summary: titleCase(`${method} ${prefix}`),
      description: '',
      responses: Object.assign({}, onSuccess[0], onError[0]),
      security: [{internalApiKey: []}]
    })

    methodsData.set(this, {spec, onSuccess, onError, parent})
  }

  tags(tags) {
    methodsData.get(this).spec.tags = toArray(tags)
    return this
  }

  summary(summary) {
    methodsData.get(this).spec.summary = summary
    return this
  }

  description(description) {
    methodsData.get(this).spec.description = description
    return this
  }

  security(value) {
    methodsData.get(this).spec.security = value
    return this
  }

  get spec() {
    return methodsData.get(this).spec
  }

  params(params) {
    this.bodyRequested = false
    methodsData.get(this).spec.parameters = toArray(params).map(param => {
      if (param.in === 'body') {
        this.bodyRequested = true
      }
      return toSpecParam(param)
    })
    return this
  }

  onSuccess(response) {
    const data = methodsData.get(this)
    data.onSuccess = []
    toArray(response).forEach(response =>
      data.onSuccess.push(toSpecResponse(data.parent, response, 200))
    )
    data.spec.responses = Object.assign(
        {},
        data.onSuccess.reduce(
            (result, response) => Object.assign(result, response),
            {}
        ),
        data.onError.reduce(
            (result, response) => Object.assign(result, response),
            {}
        )
    )
    return this
  }

  onError(response) {
    const data = methodsData.get(this)
    data.onError = []
    toArray(response).forEach(response =>
      data.onError.push(toSpecResponse(data.parent, response, 400))
    )
    data.spec.responses = Object.assign(
        {},
        data.onSuccess.reduce(
            (result, response) => Object.assign(result, response),
            {}
        ),
        data.onError.reduce(
            (result, response) => Object.assign(result, response),
            {}
        )
    )
    return this
  }

  successStatuses() {
    const data = methodsData.get(this)
    return data.onSuccess.map(response => Number(Object.keys(response)[0]))
  }

  errors() {
    const data = methodsData.get(this)
    return data.onError.map(response => ({
      status: Number(Object.keys(response)[0]),
      name: response[Object.keys(response)[0]].name,
      show: response[Object.keys(response)[0]].show,
      catch: response[Object.keys(response)[0]].catch || []
    }))
  }
}

const specsData = new WeakMap()

class Spec {
  constructor(options) {
    options = options || {}
    const spec = options.spec
    const dirname = options.__dirname
    const pack = require(findUp('package.json', {
      cwd: dirname || path.dirname(module.parent.filename)
    }))
    const it = {}
    it.spec = extend(
        {
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
          produces: ['application/json', 'text/plain; charset=utf-8'],
          schemes: ['https'],
          securityDefinitions: {
            internalApiKey: {
              type: 'apiKey',
              name: 'api_key',
              in: 'header'
            }
          }
        },
        spec
    )
    it.spec.paths = (spec && spec.paths) || {}
    it.spec.definitions = (spec && spec.definitions) || {}
    specsData.set(this, it)
  }

  setBasePath(basePath) {
    const it = specsData.get(this)
    it.spec.basePath = basePath
  }

  addDefinition(name, definition) {
    const it = specsData.get(this)
    it.spec.definitions[name] = toJsonSchema(definition)
  }

  addMethod(path, method) {
    const it = specsData.get(this)
    path = path.replace(/\:(\w*)/g, (match, name) => `{${name}}`)
    it.spec.paths[path] = it.spec.paths[path] || {}
    assert(
        it.spec.paths[path][method] === void 0,
        `Method ${method} already defined for path ${path}`
    )
    return new Method((it.spec.paths[path][method] = {}), path, method, this)
  }

  get() {
    return specsData.get(this).spec
  }
}

const routersData = new WeakMap()

class Router {
  constructor(options) {
    options = options || {}
    const prefix = options.prefix
    const router = new KoaRouter()
    const spec = new Spec(options)
    routersData.set(this, {prefix, spec, router})
  }

  param(...args) {
    const router = routersData.get(this).router
    return router.param.apply(router, args)
  }

  use(...args) {
    const router = routersData.get(this).router
    return router.use.apply(router, args)
  }

  allowedMethods(...args) {
    const router = routersData.get(this).router
    return router.allowedMethods.apply(router, args)
  }

  get spec() {
    return routersData.get(this).spec
  }

  userSpec() {
    const it = routersData.get(this)
    return async ctx => {
      const spec = await stripNotAuthorizedActions(
          ctx,
          it.prefix,
          it.spec.get()
      )
      spec.host = ctx.host
      const definition = ctx.query.definition
      if (definition) {
        ctx.body =
          definition in spec.definitions
            ? spec.definitions[definition]
            : undefined
      } else {
        ctx.body = spec
      }
    }
  }

  routes() {
    this.get('/spec', this.userSpec())
        .params({
          in: 'query',
          name: 'definition',
          description: 'Fetch only the requested definition'
        })
        .onSuccess({
          description: 'A swagger specification or definition'
        })
    return routersData.get(this).router.routes()
  }
}

function normalizeResource(prefix, resource) {
  resource = resource.replace(/\:(\w*)/g, () => '*')
  return prefix ? `/${prefix}${resource}` : `${resource}`
}

async function stripNotAuthorizedActions(ctx, prefix, spec) {
  const strip = async function() {
    spec = Object.assign({}, spec)

    const paths = {}
    const pathsKeys = Object.keys(spec.paths)
    for (let i = 0; i < pathsKeys.length; i++) {
      const path = pathsKeys[i]
      const methods = {}
      const methodsKeys = Object.keys(spec.paths[path])
      for (let j = 0; j < methodsKeys.length; j++) {
        const method = methodsKeys[j]
        try {
          const request = {
            method,
            resource: normalizeResource(prefix, path),
            spec: spec.paths[path][method],
            checkOnly: true
          }
          await ctx.state.authorize(ctx, ctx.state, request)
          methods[method] = spec.paths[path][method]
        } catch (error) {
          if (error.status !== 403) {
            throw error
          }
        }
      }

      if (Object.keys(methods).length) {
        paths[path] = methods
      }
    }

    const definitions = {}

    const refs = jsonRefs.findRefs(paths)

    Object.keys(refs).forEach(key => {
      const values = jsonRefs.pathFromPtr(refs[key].uri)
      const definition = values[1]
      definitions[definition] = spec.definitions[definition]
    })

    spec.paths = paths
    spec.definitions = definitions
    return spec
  }

  return !ctx.state.authorize ? spec : await strip()
}

methods.forEach(function(method) {
  Router.prototype[method] = function(path, middleware) {
    const it = routersData.get(this)
    const thisMethod = it.spec.addMethod(path, method)
    const normalizedResource = normalizeResource(it.prefix, path)
    const thisMethodSpec = thisMethod.spec
    const generator = isGeneratorFunction(middleware)
    it.router[method](path, async (ctx, next) => {
      try {
        if (ctx.state.authorize) {
          const request = {
            method,
            resource: normalizedResource,
            spec: thisMethodSpec
          }
          await ctx.state.authorize(ctx, ctx.state, request)
        }
        if (thisMethod.bodyRequested) {
          ctx.state.body = await parseBody(ctx, {limit: '5mb'})
        }

        if (generator) {
          await co(middleware.call(ctx, ctx, ctx.state, next))
        } else {
          await middleware(ctx, ctx.state, next)
        }

        if (ctx.body !== void 0) {
          const successStatus = thisMethod.successStatuses()
          if (successStatus.indexOf(ctx.status) === -1) {
            ctx.status = successStatus[0]
          }
        }
      } catch (e) {
        ctx.status = e.status || 500
        const errors = thisMethod.errors()
        let caught = false
        errors.forEach(error => {
          error.catch.forEach(fn => {
            if (
              !caught &&
              (typeof fn === 'string' ? e.name.startsWith(fn) : fn(e))
            ) {
              ctx.status = error.status
              ctx.body = error.show(e, ctx)
              caught = true
            }
          })
        })
        if (!caught && ctx.status !== 500) {
          ctx.body = {message: e.message}
        }
        ctx.app.emit('error', e, ctx)
      }
    })
    return thisMethod
  }
})

function toArray(any) {
  return any ? (Array.isArray(any) ? any : [any]) : []
}

function toSpecParam(param) {
  const specParam = {}
  specParam.in = param.in || 'query'
  specParam.name = param.name
  specParam.description = param.description || ''
  specParam.required =
    specParam.in === 'path' ? true : param.required === true || false
  if (param.schema) {
    specParam.schema =
      typeof param.schema === 'string'
        ? {
          $ref: `#/definitions/${param.schema}`
        }
        : param.schema
    if (param.type === 'array') {
      specParam.items = specParam.schema
      delete specParam.schema
    }
  } else if (['date', 'datetime', 'time'].indexOf(param.type) !== -1) {
    specParam.type = 'string'
  } else {
    specParam.type = param.type || 'string'
  }
  if (param.format) {
    specParam.format = param.format
  }
  return specParam
}

function toSpecResponse(spec, response, status) {
  const specResponse = {}
  const statusObject = (specResponse[response.status || status] = {})
  Object.defineProperty(statusObject, 'name', {
    value: response.name,
    writable: true
  })
  if (typeof response.schema === 'string') {
    statusObject.schema = {
      $ref: `#/definitions/${response.schema}`
    }
    statusObject.name = response.name || response.schema
  } else if ('schema' in response) {
    if (response.name) {
      spec.addDefinition(response.name, response.schema)
      statusObject.schema = {
        $ref: `#/definitions/${response.name}`
      }
    } else {
      statusObject.schema = response.schema
    }
  }
  if (typeof response.items === 'string') {
    statusObject.schema = {
      type: 'array',
      items: {
        $ref: `#/definitions/${response.items}`
      }
    }
    statusObject.name = response.name || response.schema
    delete response.items
  }
  statusObject.description =
    response.description || (status >= 400 ? 'Error' : 'Success')
  if (status >= 400) {
    Object.defineProperty(statusObject, 'show', {
      value: response.show || (error => ({message: error.message}))
    })
    Object.defineProperty(statusObject, 'catch', {
      value: response.catch || [statusObject.name]
    })
  }
  return specResponse
}

function toJsonSchema(schema, level) {
  level = level || 0
  const definition = {}
  Object.keys(schema).forEach(function(key) {
    const value = schema[key]
    if (level === 0) {
      if (['properties', 'title', 'description', 'type'].indexOf(key) === -1) {
        key = 'x-' + key
      }
    } else {
      if (
        [
          'properties',
          'title',
          'description',
          'type',
          'schema',
          'items'
        ].indexOf(key) === -1
      ) {
        key = 'x-' + key
      }
    }
    switch (typeof value) {
      // case 'function':
      //  break;
      // case 'array':
      //  definition[key] = value.slice(0);
      //  break;
      case 'object':
        definition[key] = Object.assign({}, value)
        break
      default:
        definition[key] = value
    }
  })
  const required = []
  Object.keys(definition.properties).forEach(function(key) {
    const source = definition.properties[key]
    if (source.required === true) {
      required.push(key)
    }
    const property = {}
    Object.keys(source).forEach(function(key) {
      if (key === 'required') {
        return
      }
      const value = source[key]
      if (
        [
          'title',
          'description',
          'type',
          'schema',
          'properties',
          '$ref',
          'maxLength',
          'format',
          'enum',
          'items'
        ].indexOf(key) === -1
      ) {
        key = 'x-' + key
      }
      property[key] = value
    })
    if (property.enum && property.maxLength) {
      delete property.maxLength
    }
    if (['date', 'datetime', 'time'].indexOf(property.type) !== -1) {
      property.format = property.type
      property.type = 'string'
    }
    if (property.type === 'object') {
      definition.properties[key] = toJsonSchema(property, level + 1)
    } else {
      if (property.type === 'array' && typeof property.items === 'object') {
        if (property.items.type === 'object') {
          property.items = toJsonSchema(property.items, level + 1)
        } else {
          property.items = {}
          Object.keys(source.items).forEach(function(key) {
            const value = source.items[key]
            if (['type'].indexOf(key) === -1) {
              key = 'x-' + key
            }
            property.items[key] = value
          })
        }
      } else if (property.schema) {
        const schema = {}
        if (property.schema.$ref) {
          schema['x-$ref'] = property.schema.$ref
        }
        if (property.schema.key) {
          schema['x-key'] = property.schema.key
        }
        property['x-schema'] = schema
        delete property.schema
      } else if (property.$ref) {
        property['x-$ref'] = property.$ref
        delete property.$ref
      }
      definition.properties[key] = property
    }
  })
  if (required.length) {
    definition.required = required
  }
  return definition
}

module.exports = Router
