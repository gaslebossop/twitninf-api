const { User } = require('./src/models');
const logger = require('./src/utils/logger');

async function checkUser() {
  try {
    const user = await User.findOne({ where: { username: 'gas' } });
    if (user) {
      console.log('User found:', user.id, user.username);
    } else {
      console.log('User gas not found.');
    }
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

checkUser();
