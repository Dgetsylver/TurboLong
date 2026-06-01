const https = require('https');
const data = JSON.stringify({
  method: 'getEvents',
  id: 1,
  jsonrpc: '2.0',
  params: {
    contractId: 'CDOETIUHCETALQMBMYUXGFJFA34KDTV74AMHTWXJLY2XUVNZ23JDLJZA',
    startLedger: 2860000,
    endLedger: 2863010,
    limit: 50,
  },
});
const req = https.request('https://soroban-testnet.stellar.org', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  },
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => console.log(body));
});
req.on('error', (e) => { console.error(e); process.exit(1); });
req.write(data);
req.end();
