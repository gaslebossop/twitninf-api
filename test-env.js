require('dotenv').config();

console.log('=== Test des variables d\'environnement ===');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('DB_HOST:', process.env.DB_HOST);
console.log('DB_PORT:', process.env.DB_PORT);
console.log('DB_NAME:', process.env.DB_NAME);
console.log('DB_USER:', process.env.DB_USER);
console.log('DB_PASSWORD:', process.env.DB_PASSWORD ? '***' : 'undefined');

const config = require('./src/config/config');
console.log('\n=== Configuration de la base de données ===');
console.log('Host:', config.database.host);
console.log('Port:', config.database.port);
console.log('Database:', config.database.database);
console.log('Username:', config.database.username);
console.log('Password:', config.database.password ? '***' : 'undefined');
