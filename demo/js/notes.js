import { S } from './notes/state.js';
import './notes/vault.js';
import './notes/assets.js';
import './notes/tree.js';
import './notes/tabs.js';
import './notes/revs.js';
import './notes/crud.js';
import './notes/editor.js';
import './notes/share.js';
import './notes/sync-ui.js';
import './notes/bind-share.js';
import './notes/bind-tree.js';
import './notes/bind-editor.js';
import './notes/bind.js';

const Notes = {
  init: (...a) => S.init(...a),
  load: (...a) => S.load(...a),
  open: (...a) => S.open(...a),
  create: (...a) => S.create(...a),
};
Notes.init();
export { Notes };
window.Notes = Notes;
