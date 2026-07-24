'use strict';

const config = require('../src/config/config');

console.log(JSON.stringify({
  host: config.database.host,
  port: config.database.port,
  database: config.database.database,
  username: config.database.username,
  ssl: config.database.dialectOptions.ssl
}, null, 2));
