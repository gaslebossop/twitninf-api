const axios = require('axios');
const crypto = require('crypto');

// Configuration
const API_BASE_URL = 'http://localhost:3000/api';
const TEST_USER_EMAIL = 'test@twitnin.com';
const TEST_USER_PASSWORD = 'testpassword123';

// Fonction pour générer un token d'authentification
async function authenticate() {
  try {
    console.log('🔐 Authentification...');
    
    const response = await axios.post(`${API_BASE_URL}/auth/login`, {
      email: TEST_USER_EMAIL,
      password: TEST_USER_PASSWORD
    });

    if (response.data.success) {
      console.log('✅ Authentification réussie');
      return response.data.data.token;
    } else {
      throw new Error('Échec de l\'authentification');
    }
  } catch (error) {
    console.error('❌ Erreur d\'authentification:', error.response?.data || error.message);
    throw error;
  }
}

// Fonction pour tester l'obtention d'une cryptomonnaie
async function testGetCurrency(token, symbol = 'TWC') {
  try {
    console.log(`🪙 Test obtention de la cryptomonnaie ${symbol}...`);
    
    const response = await axios.get(`${API_BASE_URL}/virtual-currency/currency/${symbol}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (response.data.success) {
      console.log('✅ Cryptomonnaie récupérée:', response.data.data);
      return response.data.data;
    } else {
      throw new Error('Échec de la récupération de la cryptomonnaie');
    }
  } catch (error) {
    console.error('❌ Erreur lors de la récupération de la cryptomonnaie:', error.response?.data || error.message);
    throw error;
  }
}

// Fonction pour tester l'obtention du portefeuille
async function testGetWallet(token, currencyId) {
  try {
    console.log('💼 Test obtention du portefeuille...');
    
    const response = await axios.get(`${API_BASE_URL}/virtual-currency/wallet/${currencyId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (response.data.success) {
      console.log('✅ Portefeuille récupéré:', response.data.data);
      return response.data.data;
    } else {
      throw new Error('Échec de la récupération du portefeuille');
    }
  } catch (error) {
    console.error('❌ Erreur lors de la récupération du portefeuille:', error.response?.data || error.message);
    throw error;
  }
}

// Fonction pour tester le minage
async function testMining(token, currencyId, action = 'Test de minage') {
  try {
    console.log(`⛏️ Test minage pour l'action: ${action}...`);
    
    const response = await axios.post(`${API_BASE_URL}/virtual-currency/mine`, {
      currencyId,
      action
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (response.data.success) {
      console.log('✅ Minage réussi:', response.data.data);
      return response.data.data;
    } else {
      throw new Error('Échec du minage');
    }
  } catch (error) {
    console.error('❌ Erreur lors du minage:', error.response?.data || error.message);
    throw error;
  }
}

// Fonction pour tester l'obtention des transactions
async function testGetTransactions(token, currencyId = null) {
  try {
    console.log('📊 Test obtention des transactions...');
    
    const params = currencyId ? `?currencyId=${currencyId}` : '';
    const response = await axios.get(`${API_BASE_URL}/virtual-currency/transactions${params}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (response.data.success) {
      console.log('✅ Transactions récupérées:', response.data.data.length, 'transactions');
      return response.data.data;
    } else {
      throw new Error('Échec de la récupération des transactions');
    }
  } catch (error) {
    console.error('❌ Erreur lors de la récupération des transactions:', error.response?.data || error.message);
    throw error;
  }
}

// Fonction pour tester le transfert (nécessite deux utilisateurs)
async function testTransfer(token, fromUserId, toUserId, currencyId, amount = 5) {
  try {
    console.log(`💸 Test transfert de ${amount} coins de ${fromUserId} vers ${toUserId}...`);
    
    const response = await axios.post(`${API_BASE_URL}/virtual-currency/transfer`, {
      toUserId,
      currencyId,
      amount,
      description: 'Test de transfert'
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (response.data.success) {
      console.log('✅ Transfert réussi:', response.data.data);
      return response.data.data;
    } else {
      throw new Error('Échec du transfert');
    }
  } catch (error) {
    console.error('❌ Erreur lors du transfert:', error.response?.data || error.message);
    throw error;
  }
}

// Fonction pour tester l'achat de cryptomonnaie
async function testPurchase(token, currencyId, amountEur = 10) {
  try {
    console.log(`🛒 Test achat de ${amountEur}€ de cryptomonnaie...`);
    
    const response = await axios.post(`${API_BASE_URL}/virtual-currency/purchase`, {
      currencyId,
      amountEur
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (response.data.success) {
      console.log('✅ Achat réussi:', response.data.data);
      return response.data.data;
    } else {
      throw new Error('Échec de l\'achat');
    }
  } catch (error) {
    console.error('❌ Erreur lors de l\'achat:', error.response?.data || error.message);
    throw error;
  }
}

// Fonction principale de test
async function runTests() {
  console.log('🚀 Début des tests de la cryptomonnaie virtuelle...\n');
  
  try {
    // 1. Authentification
    const token = await authenticate();
    
    // 2. Obtenir la cryptomonnaie
    const currency = await testGetCurrency(token);
    const currencyId = currency.id;
    
    // 3. Obtenir le portefeuille
    const walletData = await testGetWallet(token, currencyId);
    
    // 4. Tester le minage
    await testMining(token, currencyId, 'Tweet publié');
    await testMining(token, currencyId, 'Like donné');
    await testMining(token, currencyId, 'Partage effectué');
    
    // 5. Obtenir les transactions
    await testGetTransactions(token, currencyId);
    
    // 6. Tester l'achat (simulation)
    await testPurchase(token, currencyId, 5);
    
    // 7. Vérifier le portefeuille mis à jour
    const updatedWallet = await testGetWallet(token, currencyId);
    console.log('💰 Solde final:', updatedWallet.wallet.balance, currency.symbol);
    
    console.log('\n✅ Tous les tests de cryptomonnaie virtuelle ont réussi!');
    
  } catch (error) {
    console.error('\n❌ Erreur lors des tests:', error.message);
    process.exit(1);
  }
}

// Exécuter les tests si le script est appelé directement
if (require.main === module) {
  runTests()
    .then(() => {
      console.log('\n🎉 Tests terminés avec succès!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Erreur fatale:', error);
      process.exit(1);
    });
}

module.exports = {
  authenticate,
  testGetCurrency,
  testGetWallet,
  testMining,
  testGetTransactions,
  testTransfer,
  testPurchase,
  runTests
};
