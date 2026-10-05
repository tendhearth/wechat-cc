/** Reproduce the bounded ZIP reader from the pinned dependency; no runtime CDN. */
import {copyFileSync,mkdirSync} from 'node:fs'
import {dirname,resolve} from 'node:path'
import {createRequire} from 'node:module'
import {readJsonFile} from '../../../src/lib/read-json-file'
const source=dirname(createRequire(import.meta.url).resolve('fflate/package.json'))
if(readJsonFile<{version:string}>(resolve(source,'package.json')).version!=='0.8.3')throw Error('Unexpected fflate version')
const target=resolve(import.meta.dir,'../src/vendor')
mkdirSync(target,{recursive:true})
copyFileSync(resolve(source,'esm/browser.js'),resolve(target,'fflate.mjs'))
copyFileSync(resolve(source,'LICENSE'),resolve(target,'fflate-LICENSE'))
