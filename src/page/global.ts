// Script-tag entry (dist/index.global.js) — auto-inits on load, mirroring
// react-grab's index.global.js. Gate the tag on dev in the host app.
import { init } from './index';

init();
