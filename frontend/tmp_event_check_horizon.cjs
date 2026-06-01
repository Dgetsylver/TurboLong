const https = require('https');
const vaultId = 'CDOETIUHCETALQMBMYUXGFJFA34KDTV74AMHTWXJLY2XUVNZ23JDLJZA';
const url = `https://soroban-testnet.stellar.org/soroban/events?contract_id=${vaultId}&limit=5`;
https.get(url, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log(body);
  });
}).on('error', (e) => { console.error(e); process.exit(1); });
