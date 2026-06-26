
const { UserWallet, MonetizationMetrics, Tweet, VirtualCurrency } = require('./src/models');
const { POLICE_ACCOUNT_ID } = require('./src/services/policiercongo/config');

async function checkData() {
  try {
    console.log('--- CHECKING WALLETS ---');
    const wallets = await UserWallet.findAll({
      where: { userId: POLICE_ACCOUNT_ID },
      include: [{ model: VirtualCurrency, as: 'currency' }]
    });
    console.log('Wallets found:', JSON.stringify(wallets, null, 2));

    console.log('\n--- CHECKING MONETIZATION ---');
    const metrics = await MonetizationMetrics.findAll({
      include: [{
        model: Tweet,
        as: 'tweet',
        where: { user_id: POLICE_ACCOUNT_ID }
      }]
    });
    console.log('Metrics found:', metrics.length);
    metrics.forEach(m => {
      console.log(`Tweet: ${m.tweet_id}, Revenue: ${m.revenue}, Views: ${m.views}`);
    });

  } catch (error) {
    console.error('Error:', error);
  } finally {
    process.exit();
  }
}

checkData();
