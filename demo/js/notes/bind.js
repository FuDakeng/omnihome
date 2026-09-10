import { S } from './state.js';

S.init = function () {
  S.bindShare();
  S.bindTree();
  S.bindEditor();
  S.initLiveEditor();
  /* 默认进入实时渲染编辑模式（marked 不可用时自动回退源码+预览） */
  S.setMode('edit');
};
