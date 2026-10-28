// Small deterministic ZIP writer (stored entries), for redistributable source packs.
const table = Array.from({length:256},(_,n)=>{let x=n;for(let i=0;i<8;i++)x=(x&1)?0xedb88320^(x>>>1):x>>>1;return x>>>0;});
function crc32(bytes) {let crc=0xffffffff;for(const b of bytes)crc=table[(crc^b)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
export function sourceZip(files, { maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 22 * 1024 * 1024) throw new Error('Invalid archive size limit.');
  if (!Array.isArray(files) || files.length<1 || files.length>100) throw new Error('A source pack needs 1–100 files.');
  const seen=new Set(), locals=[], centrals=[];let offset=0,total=0;
  for(const file of files) {
    if(typeof file.name!=='string'||!/^[a-zA-Z0-9_.\/-]+$/.test(file.name)||file.name.startsWith('/')||file.name.split('/').some(x=>!x||x==='..'||x==='.')||seen.has(file.name))throw new Error('Invalid or duplicate archive path.');
    seen.add(file.name);const data=Buffer.from(file.data),name=Buffer.from(file.name);total+=data.length;
    if(total>maxBytes)throw new Error('Archive exceeds its size limit.');
    const crc=crc32(data),local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(33,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(33,14);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
    locals.push(local,name,data);centrals.push(central,name);offset+=local.length+name.length+data.length;
  }
  const directory=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}
