'use strict';

var koa = require('koa');
var request = require('supertest');
var http = require('http');
var chai = require('chai');
var expect = chai.expect;
chai.should();
var gutil = require('gulp-util');
var parser = require('swagger-parser');
var parseBody = require('co-body');

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
    app.use(router.routes());
    agent = request(http.createServer(app.callback()));
  });

  describe('resource', function() {
    var charlie;
    it('should have a valid swagger structure', function(done) {
      agent
        .get('/')
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(200)
        .end(function(err, res) {
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
        });
    });
    it('should get the person definition', function(done) {
      agent
        .get('/?definition=person')
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(200)
        .expect(function(res) {
          let definition = res.body;
          definition.should.have.property('properties');
        })
        .end(logError(done));
    });
    it('no person exists', function(done) {
      agent
        .get('/person/8')
        .set('Accept', 'application/json')
        .expect('Content-Type', /text/)
        .expect(404)
        .end(logError(done));
    });
    it('should create a new person', function(done) {
      let now = (new Date()).toISOString();
      agent
        .post('/person')
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
      let body = yield parseBody(this);
      this.body = yield entity.create(body);
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
      let body = yield parseBody(this);
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
      let body = yield parseBody(this);
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


