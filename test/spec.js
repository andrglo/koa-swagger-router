'use strict';

var koa = require('koa');
var request = require('supertest');
var assert = require('assert');
var http = require('http');
var chai = require('chai');
var co = require('@ayk/co');
var expect = chai.expect;
chai.should();
var gutil = require('gulp-util');
var parser = require('swagger-parser');

var RouterFactory = require('../src');

function logError(done) {
  return function(error, res) {
    if (error) {
      res = res.res;
      gutil.log('Error response text / body:',
        gutil.colors.red(res.text), '/', res.body);
    }
    done(error);
  };
}

function log() {
  console.log.apply(null, Array.prototype.slice.call(arguments)
    .map(arg => JSON.stringify(arg, null, '  ')));
}

const effect = (o) => Promise.resolve(o);
const pubRoute = function*(ctx, { allCaughtUp }) {
  ctx.body = { executed: yield co.effect(effect, allCaughtUp) };
};

module.exports = function(options) {

  var agent;
  var router;
  before(function() {
    var app = koa();
    router = new RouterFactory(options.authDb);
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
    });
    addStandardEntityMethods(router, 'person', options.entity);
    router.use(function*(next) {
      if (this.header.role === 'sa' || this.header.role === 'admin') {
        this.state.user = {
          admin: true
        };
      } else {
        this.state.user = {
          roles: [this.header.role]
        };
      }
      this.state.db = options.db;
      this.state.allCaughtUp = true;

      this.state.authorize = function*(method, resource, spec) {
        if (resource === '/spec' || spec.security && spec.security.length === 0) {
          return; // has access
        }
        let user = this.state.user;
        if (user.admin !== true) {
          this.throw(403);
        }
      };

      yield next;
    });
    router.get('/public', pubRoute).security([]); // => none
    router.get('/private', function*() {
      this.body = { executed: true };
    });
    router.get('/error400', function*() {
      assert(false, 'assertion');
    }).onError({
      name: 'AssertionError',
      schema: 'other'
    });
    router.get('/error410', function*() {
      assert(false, 'assertion');
    }).onError([{
      name: 'AssertionError',
      schema: {
        properties: {
          name: {
            type: 'string'
          }
        }
      },
      status: 410,
      show: (e, ctx) => ({ message: 'message is ' + e.message + (ctx.state ? '' : 'error')})
    }, {
      name: 'AssertionError',
      schema: {
        properties: {
          name: {
            type: 'string'
          }
        }
      },
      status: 400,
      show: (e) => ({ message: 'message is ' + e.message })
    }]);
    app.use(router.routes());
    agent = request(http.createServer(app.callback()));
  });

  describe('effects', function() {
    it('do a unit test of the route', function() {
      const gen = pubRoute({}, { allCaughtUp: false });
      let value = gen.next();
      expect(value.value).to.eql(co.effect(effect, false));
      value = gen.next(false);
      expect(value.value).to.be.undefined;
      expect(value.done).to.be.true;
    });
  });

  describe('resource', function() {
    var charlie;
    it('should always allow a request to the spec', function(done) {
      agent
        .get('/spec')
        .expect(200)
        .expect(function(res) {
          let spec = res.body;
          spec.should.have.property('paths');
          spec.paths.should.have.property('/public');
          spec.paths.should.have.property('/spec');
          spec.paths.should.not.have.property('/private');
        })
        .end(logError(done));
    });
    it('should have a valid swagger structure in getter', function(done) {
      let spec = router.spec.get();
      parser.validate(spec, {
        $refs: {
          internal: false   // Don't dereference internal $refs, only external
        }
      }, function(err) {
        if (err) {
          gutil.log('Swagger getter specification:\n', spec);
          gutil.log('Error:\n', gutil.colors.red(err));
        } else {
          expect(spec.definitions.AssertionError).to.exist;
          done(err);
        }
      });
    });
    it('should have a valid swagger structure in request', function(done) {
      agent
        .get('/spec')
        .set('Accept', 'application/json')
        .set('role', 'sa')
        .expect(200)
        .end(function(err, res) {
          if (err) {
            done(err);
          } else {
            let spec = res.body;
            parser.validate(spec, {
              $refs: {
                internal: false   // Don't dereference internal $refs, only external
              }
            }, function(err) {
              if (err) {
                gutil.log('Swagger specification:\n', JSON.stringify(spec, null, '  '));
                gutil.log('Error:\n', gutil.colors.red(err));
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
                  });
                } catch (e) {
                  err = e;
                }
              }
              done(err);
            });
          }
        });
    });
    it('should get the other definition', function(done) {
      agent
        .get('/spec?definition=other')
        .set('role', 'sa')
        .set('Accept', 'application/json')
        .expect(200)
        .expect(function(res) {
          let definition = res.body;
          definition.should.have.property('properties');
        })
        .end(logError(done));
    });
    it('should have a valid swagger structure only with the allowed actions', function(done) {
      agent
        .get('/spec')
        .set('Accept', 'application/json')
        .set('role', 'cr')
        .expect(200)
        .end(function(err, res) {
          if (err) {
            done(err);
          } else {
            let spec = res.body;
            parser.validate(spec, {
              $refs: {
                internal: false   // Don't dereference internal $refs, only external
              }
            }, function(err) {
              if (err) {
                gutil.log('Swagger specification:\n', JSON.stringify(spec, null, '  '));
                gutil.log('Error:\n', gutil.colors.red(err));
              } else {
                try {
                  expect(spec.paths['/person/{name}']).to.be.undefined;
                } catch (e) {
                  err = e;
                }
              }
              done(err);
            });
          }
        });
    });
    it('should not get the other definition', function(done) {
      agent
        .get('/spec?definition=other')
        .set('role', 'cr')
        .set('Accept', 'application/json')
        .expect(404)
        .end(logError(done));
    });
    it('no person exists', function(done) {
      agent
        .get('/person/8')
        .set('role', 'admin')
        .set('Accept', 'application/json')
        .expect('Content-Type', /text/)
        .expect(404)
        .end(logError(done));
    });
    it('should create a new person', function(done) {
      let now = (new Date()).toISOString();
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
          let record = charlie = res.body;
          record.should.have.property('name');
          record.should.have.property('createdAt');
          record.should.have.property('updatedAt');
          record.createdAt.should.equal(record.updatedAt);
          expect(record.createdAt).to.be.a('string');
          expect(record.createdAt).to.above(now);
        })
        .end(logError(done));
    });
    it('should update address', function(done) {
      charlie.address = 'Victoria St';
      agent
        .put('/person/' + charlie.name)
        .set('role', 'admin')
        .send(charlie)
        .expect(200)
        .expect('Content-Type', /json/)
        .expect(function(res) {
          let record = charlie = res.body;
          record.should.have.property('address');
          record.should.not.have.property('code');
        })
        .end(logError(done));
    });
    it('read charlie', function(done) {
      agent
        .get('/person?name=Charlie')
        .set('role', 'admin')
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(200)
        .expect(function(res) {
          let recordset = res.body;
          expect(recordset).to.be.a('array');
          expect(recordset.length).to.equal(1);
          let record = recordset[0];
          record.should.have.property('address');
          record.should.not.have.property('code');
        })
        .end(logError(done));
    });
    it('delete charlie', function(done) {
      agent
        .delete('/person/Charlie')
        .set('role', 'admin')
        .send(charlie)
        .set('Accept', 'application/json')
        .expect(204)
        .end(logError(done));
    });
  });

  describe('Public and private resources', function() {
    it('should allow a request to public', function(done) {
      agent
        .get('/public')
        .expect(200)
        .end(logError(done));
    });
    it('should deny a request to private', function(done) {
      agent
        .get('/private')
        .expect(403)
        .end(logError(done));
    });
  });

  describe('Error status handling', function() {
    it('Should return a 400 error', function(done) {
      agent
        .get('/error400')
        .set('role', 'sa')
        .expect(400)
        .end(logError(done));
    });
    it('Should return a 410 error', function(done) {
      agent
        .get('/error410')
        .set('role', 'sa')
        .expect(410)
        .expect(function(res) {
          expect(res.body.message).to.equal('message is assertion');
        })
        .end(logError(done));
    });
  });

};

function addStandardEntityMethods(router, name, entity) {

  var primaryKey = entity.schema.primaryKey()[0];

  function buildCriteria(key, updatedAt) {
    let criteria = { where: {} };
    criteria.where[primaryKey] = key;
    if (updatedAt !== void 0) {
      criteria.where.updatedAt = updatedAt;
    }
    return criteria;
  }

  let schema = entity.schema.get();
  router.spec.addDefinition(name, schema);
  router.spec.addDefinition('DatabaseError', {
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
  });
  let show = error => ({
    name: 'DatabaseError',
    message: error.message,
    details: []
  });

  let queryColumns = [];
  Object.keys(schema.properties).map(function(key) {
    let column = schema.properties[key];
    if (column.type !== 'object' && column.type !== 'array') {
      queryColumns.push({
        name: key,
        description: column.description,
        type: column.type
      });
    }
  });

  router
    .get(`/modules`, function*() {
      this.body = ['none'];
    })
    .onSuccess({
      description: 'A list of available modules',
      schema: {
        type: 'array',
        items: {
          type: 'string'
        }
      }
    });

  router
    .get(`/${name}`, function*() {
      let criteria = this.query.criteria;
      if (criteria) {
        criteria = JSON.parse(criteria);
        criteria.where = criteria.where || {};
      } else {
        criteria = {
          where: {}
        };
      }
      queryColumns.forEach(column => {
        let value = this.query[column.name];
        if (value) {
          criteria.where[column.name] = value;
        }
      });
      this.body = yield entity.new(this.state.db).fetch(criteria);
    })
    .description('Get a list of available modules')
    .summary('Summary')
    .description(`Get ${name} list`)
    .params([{
      name: 'criteria',
      description: 'Filter, order and or pagination to apply'
    }].concat(queryColumns))
    .onSuccess({
      items: name
    })
    .onError({
      name: 'DatabaseError',
      catch: ['EntityError', 'RequestError'],
      show
    });

  router
    .get(`/${name}/:${primaryKey}`, function*() {
      let recordset = yield entity.new(this.state.db).fetch(buildCriteria(this.params[primaryKey]));
      if (recordset.length) {
        this.body = recordset[0];
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
    });

  router
    .post(`/${name}`, function*() {
      this.body = yield entity.new(this.state.db).create(this.state.body);
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
    });

  router
    .put(`/${name}/:${primaryKey}`, function*() {
      let body = this.state.body;
      let id = this.params[primaryKey];
      this.body = yield entity.new(this.state.db).update(body, buildCriteria(id, body.updatedAt));
    })
    .params([{
      in: 'path',
      name: primaryKey,
      description: 'Object id'
    }, {
      in: 'body',
      name: 'updatedAt',
      description: `${primaryKey} to be updated`,
      required: true,
      schema: name
    }])
    .onSuccess({
      items: name
    })
    .onError({
      schema: 'EntityError'
    });

  router
    .delete(`/${name}/:${primaryKey}`, function*() {
      let body = this.state.body;
      let id = this.params[primaryKey];
      this.body = yield entity.new(this.state.db).destroy(buildCriteria(id, body.updatedAt));
    })
    .params([{
      in: 'path',
      name: primaryKey,
      description: 'Object id',
      required: true,
      type: 'integer'
    }, {
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
    }])
    .onSuccess({
      status: 204
    })
    .onError({
      schema: 'EntityError'
    });
}


