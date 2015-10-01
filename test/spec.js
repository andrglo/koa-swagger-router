'use strict';

var koa = require('koa');
var request = require('supertest');
var http = require('http');
var chai = require('chai');
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

module.exports = function(options) {

  var agent;
  var router;
  before(function() {
    var app = koa();
    router = new RouterFactory();
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
      this.state.user = {
        admin: this.header.role === 'admin',
        role: this.header.role
      };
      yield next;
    });
    app.use(router.routes());
    agent = request(http.createServer(app.callback()));
  });

  describe('resource', function() {
    var charlie;
    it('should deny a request to the spec', function(done) {
      agent
        .get('/spec')
        .expect(403)
        .end(logError(done));
    });
    it('should have a valid swagger structure', function(done) {
      agent
        .get('/spec')
        .set('Accept', 'application/json')
        .set('role', 'admin')
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
              }
              done(err);
            });
          }
        });
    });
    it('should get the other definition', function(done) {
      agent
        .get('/spec?definition=other')
        .set('role', 'admin')
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

};

function addStandardEntityMethods(router, name, entity) {

  var primaryKey = entity.schema.primaryKey()[0];

  function buildCriteria(key, updatedAt) {
    let criteria = {where: {}};
    criteria.where[primaryKey] = key;
    if (updatedAt !== void 0) {
      criteria.where.updatedAt = updatedAt;
    }
    return criteria;
  }

  let schema = entity.schema.get();
  router.spec.addDefinition(name, schema);
  router.spec.addDefinition('EntityError', { //todo
    properties: {
      name: {
        type: 'array',
        items: {
          type: 'string',
          description: 'none'
        }
      }
    }
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
      this.body = yield entity.fetch(criteria);
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
      schema: 'EntityError'
    });

  router
    .get(`/${name}/:${primaryKey}`, function*() {
      let recordset = yield entity.fetch(buildCriteria(this.params[primaryKey]));
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
      this.body = yield entity.create(this.state.body);
    })
    .params({
      in: 'body',
      name: 'body',
      description: `${name} to be added`,
      required: true,
      schema: name
    })
    .onSuccess({
      schema: name,
      status: 201
    })
    .onError({
      schema: 'EntityError'
    });

  router
    .put(`/${name}/:${primaryKey}`, function*() {
      let body = this.state.body;
      let id = this.params[primaryKey];
      this.body = yield entity.update(body, buildCriteria(id, body.updatedAt));
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
      this.body = yield entity.destroy(buildCriteria(id, body.updatedAt));
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


