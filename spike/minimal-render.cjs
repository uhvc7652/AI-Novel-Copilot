const { createRequire } = require('node:module')
const req = createRequire('E:/GameProject/AI-Novel-Copilot/spike/x.mjs')
const React = req('react')
const { renderToStaticMarkup } = req('react-dom/server')
console.log('react path:', require.resolve ? '' : '')
console.log('React version:', React.version)
function Hello() { const [n] = React.useState(1); return React.createElement('b', null, 'n=' + n) }
try { console.log('minimal render ok:', renderToStaticMarkup(React.createElement(Hello))) }
catch (e) { console.log('minimal render FAILED:', e.message) }
console.log('same instance via two requires:', req('react') === req('react'))
