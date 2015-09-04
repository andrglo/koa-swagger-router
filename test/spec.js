'use strict';

var koa = require('koa');
var request = require('supertest');
var http = require('http');
var chai = require('chai');
var expect = chai.expect;
chai.should();
var gutil = require('gulp-util');

var routerFactory = require('../src');

function log(done) {
  return function(error, res) {
    if (error) {
      res = res.res;
      gutil.log('Error response text / body:',
        gutil.colors.red(res.text), '/', res.body);
    }
    done(error);
  };
}

module.exports = function(options) {

  var agent;
  before(function() {
    var app = koa();
    var router = routerFactory(__dirname + '/spec.yaml');
    router.add('person',
      options.entity,
      entityMethods(options.entity, 'name'), {
        person: options.entity.getSchema()
      });
    app.use(router.routes());
    agent = request(http.createServer(app.callback()));
  });

  describe('resource', function() {
    var charlie;
    it('no person exists', function(done) {
      agent
        .get('/person/8')
        .set('Accept', 'application/json')
        .expect('Content-Type', /text/)
        .expect(404)
        .end(log(done));
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
        .end(log(done));
    });
    it('should update address', function(done) {
      charlie.address = 'Victoria St';
      agent
        .put('/person/' + charlie.name)
        .send(charlie)
        .expect('Content-Type', /json/)
        .expect(200)
        .expect(function(res) {
          let record = charlie = res.body;
          record.should.have.property('address');
          record.should.not.have.property('code');
        })
        .end(log(done));
    });
  });

};

function entityMethods(entity, id) {

  function buildCriteria(key) {
    let criteria = {where: {}};
    criteria.where[id] = key;
    return criteria;
  }

  return {

    get: {
      operationId: 'fetch',
      parameters: {
        parse: function(query) {
          var criteria;
          if (query.criteria) {
            criteria = JSON.parse(query.criteria);
          } else {
            criteria = {
              where: query
            };
          }
          return [criteria];
        }
      },
      response: {
        type: 'array',
        schema: entity.getSchema()
      }
    },
    post: {
      operationId: 'create',
      response: {
        status: 201
      }
    },
    [`put :${id}`]: {
      operationId: 'update',
      parameters: {
        parse: function(id, body) {
          return [body, buildCriteria(id)];
        }
      },
      response: {
        type: 'array',
        definition: 'person'
      }
    },
    [`get :${id}`]: {
      operationId: 'fetch',
      parameters: {
        parse: function(id) {
          return [buildCriteria(id)];
        }
      },
      response: {
        parse: function(recordset) {
          return recordset.length ? recordset[0] : void 0;
        },
        type: 'object',
        definition: 'person'
      }
    },
    [`delete :${id}`]: {
      operationId: 'destroy',
      parameters: {
        parse: function(id) {
          return [buildCriteria(id)];
        }
      },
      response: {
        status: 204,
        parse: function(recordset) {
          return recordset[0];
        }
      }
    }
  };

}


