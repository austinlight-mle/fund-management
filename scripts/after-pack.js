'use strict';

// electron-builder "afterPack" hook: runs after the app is packed and before it
// is signed and turned into .dmg/.zip.
// Without an Apple Developer certificate the macOS app would stay unsigned, and
// Apple Silicon Macs refuse to run apps without a valid signature. In that case
// sign the bundle ad-hoc so it runs once the user approves it.
// With a certificate (CSC_LINK / CSC_NAME) electron-builder signs and notarizes
// the app right after this hook, so nothing is done here.
// (afterSign would not work: electron-builder skips it when nothing was signed.)

const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing  app=${app}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
