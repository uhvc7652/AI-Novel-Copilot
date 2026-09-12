// Sanity check for the js-yaml install before it becomes a runtime dependency.
const path = 'E:/GameProject/AI-Novel-Copilot/node_modules/js-yaml/package.json'
const manifest = require(path)
console.log('version:', manifest.version)
console.log('description:', manifest.description)
console.log('repository:', JSON.stringify(manifest.repository))
console.log('homepage:', manifest.homepage)
const yaml = require('E:/GameProject/AI-Novel-Copilot/node_modules/js-yaml')
console.log('api load/dump:', typeof yaml.load, typeof yaml.dump)
const parsed = yaml.load('a: 1\nb: [x, y]\nc: "你好：世界"\nd:\n  - one\n  - two\n')
console.log('parse result:', JSON.stringify(parsed))
console.log('dump round trip:', JSON.stringify(yaml.dump({ title: '楔子·雨夜', tags: ['a', 'b'] })))
