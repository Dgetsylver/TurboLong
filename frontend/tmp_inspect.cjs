(async () => {
  const { rpc: SorobanRpc } = await import('@stellar/stellar-sdk');
  console.log(Object.getOwnPropertyNames(SorobanRpc.Server.prototype).sort());
})();
