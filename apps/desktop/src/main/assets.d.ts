// What electron-vite's `?asset` imports give the main process: the file's path (`asarUnpack`: the path in `app.asar.unpacked`).
declare module "*?asset" {
  const filePath: string;
  export default filePath;
}
declare module "*?asset&asarUnpack" {
  const filePath: string;
  export default filePath;
}
