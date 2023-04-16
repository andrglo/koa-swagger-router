const PgCrLayer = require('pg-cr-layer')
const jse = require('json-schema-entity')
const personSchema = require('./schemas/person.json')

const spec = require('./spec')

const pgConfig = {
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: 'postgres',
  host: process.env.PGHOST || 'localhost',
  port: process.env.PGPORT || 5432,
  pool: {
    max: 10,
    idleTimeout: 30000
  }
}
const pg = new PgCrLayer(pgConfig)

const databaseName = 'test-koa-swagger-router'

function createPostgresDb() {
  const dbName = process.env.PGDATABASE || databaseName
  return pg
      .execute('DROP DATABASE IF EXISTS "' + dbName + '";')
      .then(function() {
        return pg.execute('CREATE DATABASE "' + dbName + '"')
      })
}

const pgOptions = {}

before(function() {
  return pg.connect().then(function() {
    return createPostgresDb()
        .then(function() {
          console.log('Postgres db created')
          return pg.close()
        })
        .then(function() {
          console.log('Postgres db creation connection closed')
          pgConfig.database = process.env.POSTGRES_DATABASE || databaseName
          console.log('Postgres will connect to', pgConfig.database)
          pgOptions.db = new PgCrLayer(pgConfig)
          return pgOptions.db.connect()
        })
        .then(function() {
          pgOptions.entity = jse('person', personSchema, {dialect: 'pg'})
          pgOptions.entity.useTimestamps()
          pgOptions.entity
              .hasMany('person as children', personSchema)
              .foreignKey('fkChildren')
          pgOptions.entity
              .hasOne('person as parent', personSchema)
              .foreignKey('fkParent')
          return pgOptions.entity.new(pgOptions.db).createTables()
        })
  })
})

describe('postgres', function() {
  let duration
  before(function() {
    duration = process.hrtime()
  })
  spec(pgOptions)
  after(function() {
    duration = process.hrtime(duration)
    console.info(
        'postgres finished after: %ds %dms',
        duration[0],
        duration[1] / 1000000
    )
  })
})

after(function() {
  pgOptions.db.close()
})
