/* OmniHome · ESM 入口：按依赖顺序加载，最后启动应用。 */
import './demo.js';
import './phone.js';
import { API } from './api.js';
import { App } from './app.js';
import { Auth } from './auth.js';
import './weather.js';
import './monitor.js';
import './word.js';
import './calendar.js';
import { Bookmarks } from './bookmarks.js';
import './globalsearch.js';
import { Vault } from './vault.js';
import { LiveMD } from './livemd.js';
import { Dash } from './dashboard.js';
import { Notes } from './notes.js';
import './notes/quick.js';
import { Plan } from './plan.js';
import './toolbox.js';
import './settings.js';

void API;
void Auth;
void Bookmarks;
void Vault;
void LiveMD;
void Dash;
void Notes;
void Plan;

App.boot();
