const Koa = require('koa')
const request = require('supertest')
const assert = require('assert')
const http = require('http')
const chai = require('chai')
const expect = chai.expect
chai.should()
const parser = require('swagger-parser')

const RouterFactory = require('../src')

function logError(done) {
  return function(error, res) {
    if (error) {
      res = res.res
      console.error('Error response text / body:', res.text, '/', res.body)
    }
    done(error)
  }
}

const effect = o => Promise.resolve(o)
const pubRoute = async (ctx, {allCaughtUp}) => {
  ctx.body = {executed: await effect(allCaughtUp)}
}

module.exports = function(options) {
  let agent
  let router
  before(function() {
    const app = new Koa()
    router = new RouterFactory(options.authDb)
    router.spec.addDefinition('other', {
      myProperty: 'invalid swagger',
      properties: {
        name: {
          type: 'array',
          items: {
            type: 'string',
            description: 'none'
          }
        },
        otherProperty: {
          type: 'object',
          format: 'none',
          properties: {
            name: {
              type: 'string'
            }
          }
        }
      }
    })
    router.use(async (ctx, next) => {
      if (ctx.header.role === 'sa' || ctx.header.role === 'admin') {
        ctx.state.user = {
          admin: true
        }
      } else {
        ctx.state.user = {
          roles: [ctx.header.role]
        }
      }
      ctx.state.db = options.db
      ctx.state.allCaughtUp = true

      ctx.state.authorize = async function(ctx, state, {resource, spec}) {
        if (
          resource === '/spec' ||
          (spec.security && spec.security.length === 0)
        ) {
          return // has access
        }
        const user = ctx.state.user
        if (user.admin !== true) {
          ctx.throw(403)
        }
      }
      await next()
    })
    addStandardEntityMethods(router, 'person', options.entity)
    router.get('/public', pubRoute).security([]) // => none
    router.get('/private', async ctx => {
      ctx.body = {executed: true}
    })
    router
        .get('/error400', async () => assert(false, 'assertion'))
        .onError({
          name: 'AssertionError',
          schema: 'other'
        })
    router
        .get('/error410', function *() {
          assert(false, 'assertion')
        })
        .onError([
          {
            name: 'AssertionError',
            schema: {
              properties: {
                name: {
                  type: 'string'
                }
              }
            },
            status: 410,
            show: (e, ctx) => ({
              message: 'message is ' + e.message + (ctx.state ? '' : 'error')
            })
          },
          {
            name: 'AssertionError',
            schema: {
              properties: {
                name: {
                  type: 'string'
                }
              }
            },
            status: 400,
            show: e => ({message: 'message is ' + e.message})
          }
        ])
    app.use(router.routes())
    app.on('error', (err, ctx) => {})
    agent = request(http.createServer(app.callback()))
  })

  describe('resource', function() {
    let charlie
    it('should always allow a request to the spec', function(done) {
      agent
          .get('/spec')
          .expect(200)
          .expect(function(res) {
            const spec = res.body
            spec.should.have.property('paths')
            spec.paths.should.have.property('/public')
            spec.paths.should.have.property('/spec')
            spec.paths.should.not.have.property('/private')
          })
          .end(logError(done))
    })
    it('should have a valid swagger structure in getter', function(done) {
      const spec = router.spec.get()
      parser.validate(JSON.parse(JSON.stringify(spec)), function(err) {
        const spec = router.spec.get()
        if (err) {
          console.log(
              'Swagger getter specification:\n',
              JSON.stringify(spec, null, '  ')
          )
          console.error('Error:\n', err)
        } else {
          expect(spec.definitions.AssertionError).to.exist
        }
        done(err)
      })
    })
    it('should have a valid swagger structure in request', function(done) {
      agent
          .get('/spec')
          .set('Accept', 'application/json')
          .set('role', 'sa')
          .expect(200)
          .end(function(err, res) {
            if (err) {
              done(err)
            } else {
              const spec = res.body
              parser.validate(JSON.parse(JSON.stringify(spec)), function(err) {
                if (err) {
                  console.log(
                      'Swagger specification:\n',
                      JSON.stringify(spec, null, '  ')
                  )
                  console.error('Error:\n', err)
                } else {
                  try {
                    expect(spec.paths['/modules'].get.responses['200']).to.eql({
                      description: 'A list of available modules',
                      schema: {
                        type: 'array',
                        items: {
                          type: 'string'
                        }
                      }
                    })
                  } catch (e) {
                    err = e
                  }
                }
                done(err)
              })
            }
          })
    })
    it('should get the other definition', function(done) {
      agent
          .get('/spec?definition=other')
          .set('role', 'sa')
          .set('Accept', 'application/json')
          .expect(200)
          .expect(function(res) {
            const definition = res.body
            definition.should.have.property('properties')
          })
          .end(logError(done))
    })
    it('should have a valid swagger structure only with the allowed actions', function(done) {
      agent
          .get('/spec')
          .set('Accept', 'application/json')
          .set('role', 'cr')
          .expect(200)
          .end(function(err, res) {
            if (err) {
              done(err)
            } else {
              const spec = res.body
              parser.validate(JSON.parse(JSON.stringify(spec)), function(err) {
                if (err) {
                  console.log(
                      'Swagger specification:\n',
                      JSON.stringify(spec, null, '  ')
                  )
                  console.error('Error:\n', err)
                } else {
                  try {
                    expect(spec.paths['/person/{name}']).to.be.undefined
                  } catch (e) {
                    err = e
                  }
                }
                done(err)
              })
            }
          })
    })
    it('should not get the other definition', function(done) {
      agent
          .get('/spec?definition=other')
          .set('role', 'cr')
          .set('Accept', 'application/json')
          .expect(204)
          .end(logError(done))
    })
    it('no person exists', function(done) {
      agent
          .get('/person/8')
          .set('role', 'admin')
          .set('Accept', 'application/json')
          .expect('Content-Type', /text/)
          .expect(404)
          .end(logError(done))
    })
    it('should create a new person', function(done) {
      const now = new Date().toISOString()
      agent
          .post('/person')
          .set('role', 'admin')
          .set('Content-Type', 'application/json')
          .send({
            name: 'Charlie'
          })
          .expect('Content-Type', /json/)
          .expect(201)
          .expect(function(res) {
            const record = (charlie = res.body)
            record.should.have.property('name')
            record.should.have.property('createdAt')
            record.should.have.property('updatedAt')
            record.createdAt.should.equal(record.updatedAt)
            expect(record.createdAt).to.be.a('string')
            expect(record.createdAt >= now).equal(true)
          })
          .end(logError(done))
    })
    it('should update address', function(done) {
      charlie.address = 'Victoria St'
      agent
          .put('/person/' + charlie.name)
          .set('role', 'admin')
          .send(charlie)
          .expect(200)
          .expect('Content-Type', /json/)
          .expect(function(res) {
            const record = (charlie = res.body)
            record.should.have.property('address')
            record.should.not.have.property('code')
          })
          .end(logError(done))
    })
    it('read charlie', function(done) {
      agent
          .get('/person?name=Charlie')
          .set('role', 'admin')
          .set('Accept', 'application/json')
          .expect('Content-Type', /json/)
          .expect(200)
          .expect(function(res) {
            const recordset = res.body
            expect(recordset).to.be.a('array')
            expect(recordset.length).to.equal(1)
            const record = recordset[0]
            record.should.have.property('address')
            record.should.not.have.property('code')
          })
          .end(logError(done))
    })
    it('delete charlie', function(done) {
      agent
          .delete('/person/Charlie')
          .set('role', 'admin')
          .send(charlie)
          .set('Accept', 'application/json')
          .expect(204)
          .end(logError(done))
    })
  })

  describe('Public and private resources', function() {
    it('should allow a request to public', function(done) {
      agent
          .get('/public')
          .expect(200)
          .end(logError(done))
    })
    it('should deny a request to private', function(done) {
      agent
          .get('/private')
          .expect(403)
          .end(logError(done))
    })
  })

  describe('Error status handling', function() {
    it('Should return a 400 error', function(done) {
      agent
          .get('/error400')
          .set('role', 'sa')
          .expect(400)
          .end(logError(done))
    })
    it('Should return a 410 error', function(done) {
      agent
          .get('/error410')
          .set('role', 'sa')
          .expect(410)
          .expect(function(res) {
            expect(res.body.message).to.equal('message is assertion')
          })
          .end(logError(done))
    })
  })
}

function addStandardEntityMethods(router, name, entity) {
  const primaryKey = entity.schema.primaryKey()[0]

  function buildCriteria(key, updatedAt) {
    const criteria = {where: {}}
    criteria.where[primaryKey] = key
    if (updatedAt !== void 0) {
      criteria.where.updatedAt = updatedAt
    }
    return criteria
  }

  const schema = entity.schema.get()
  router.spec.addDefinition(name, schema)
  router.spec.addDefinition('EntityError', {
    properties: {
      name: {
        type: 'string'
      },
      message: {
        type: 'string'
      },
      details: {
        type: 'array',
        items: {
          type: 'string'
        }
      }
    }
  })
  const show = error => ({
    name: 'DatabaseError',
    message: error.message,
    details: []
  })

  const queryColumns = []
  Object.keys(schema.properties).map(function(key) {
    const column = schema.properties[key]
    if (column.type !== 'object' && column.type !== 'array') {
      queryColumns.push({
        name: key,
        description: column.description,
        type: column.type
      })
    }
  })

  router
      .get('/modules', async ctx => {
        ctx.body = ['none']
      })
      .onSuccess({
        description: 'A list of available modules',
        schema: {
          type: 'array',
          items: {
            type: 'string'
          }
        }
      })

  router
      .get(`/${name}`, async ctx => {
        let criteria = ctx.query.criteria
        if (criteria) {
          criteria = JSON.parse(criteria)
          criteria.where = criteria.where || {}
        } else {
          criteria = {
            where: {}
          }
        }
        queryColumns.forEach(column => {
          const value = ctx.query[column.name]
          if (value) {
            criteria.where[column.name] = value
          }
        })
        ctx.body = await entity.new(ctx.state.db).fetch(criteria)
      })
      .description('Get a list of available modules')
      .summary('Summary')
      .description(`Get ${name} list`)
      .params(
          [
            {
              name: 'criteria',
              description: 'Filter, order and or pagination to apply'
            }
          ].concat(queryColumns)
      )
      .onSuccess({
        items: name
      })
      .onError({
        name: 'DatabaseError',
        catch: ['EntityError', 'RequestError'],
        show
      })

  router
      .get(`/${name}/:${primaryKey}`, async ctx => {
        const recordset = await entity
            .new(ctx.state.db)
            .fetch(buildCriteria(ctx.params[primaryKey]))
        if (recordset.length) {
          ctx.body = recordset[0]
        }
      })
      .params({
        in: 'path',
        name: primaryKey,
        description: `${name} to be find`
      })
      .onSuccess({
        items: name
      })
      .onError({
        schema: 'EntityError'
      })

  router
      .post(`/${name}`, async ctx => {
        ctx.body = await entity.new(ctx.state.db).create(ctx.state.body)
      })
      .params({
        in: 'body',
        name: 'body',
        description: `${name} to be added`,
        required: true,
        schema: name
      })
      .onSuccess({
        name,
        status: 201
      })
      .onError({
        schema: 'EntityError'
      })

  router
      .put(`/${name}/:${primaryKey}`, async ctx => {
        const body = ctx.state.body
        const id = ctx.params[primaryKey]
        ctx.body = await entity
            .new(ctx.state.db)
            .update(body, buildCriteria(id, body.updatedAt))
      })
      .params([
        {
          in: 'path',
          name: primaryKey,
          description: 'Object id'
        },
        {
          in: 'body',
          name: 'updatedAt',
          description: `${primaryKey} to be updated`,
          required: true,
          schema: name
        }
      ])
      .onSuccess({
        items: name
      })
      .onError({
        schema: 'EntityError'
      })

  router
      .delete(`/${name}/:${primaryKey}`, async ctx => {
        const body = ctx.state.body
        const id = ctx.params[primaryKey]
        ctx.body = await entity
            .new(ctx.state.db)
            .destroy(buildCriteria(id, body.updatedAt))
      })
      .params([
        {
          in: 'path',
          name: primaryKey,
          description: 'Object id',
          required: true,
          type: 'integer'
        },
        {
          in: 'body',
          name: 'updatedAt',
          description: 'Last update timestamp',
          required: true,
          schema: {
            type: 'object',
            properties: {
              updatedAt: {
                type: 'string',
                format: 'date-time'
              }
            }
          }
        }
      ])
      .onSuccess({
        status: 204
      })
      .onError({
        schema: 'EntityError'
      })
}
