import { createWorkbenchServer } from '../src/workbench-server.mjs';
const port=Number(process.env.GAMEBRIDGE_PORT||4173);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid GAMEBRIDGE_PORT.');
const server=createWorkbenchServer();
server.listen(port,'127.0.0.1',()=>console.log(`GameBridge AI Mod Studio: http://127.0.0.1:${port}`));
server.on('error',error=>{console.error(error.message);process.exitCode=1;});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close());
