import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
await build({entryPoints:['src/app.tsx'],bundle:true,minify:true,format:'iife',target:'es2022',outfile:'../cnc-map-web/app.bundle.js',legalComments:'eof'});
execFileSync(process.execPath,['node_modules/@tailwindcss/cli/dist/index.mjs','-i','src/styles.css','-o','../cnc-map-web/app.css','--minify'],{stdio:'inherit'});
