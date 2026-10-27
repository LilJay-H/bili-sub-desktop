// 杂志编辑风格：纸色、墨色、赭红强调；空闲时保持全框阅读，设置有独立滚动区。
window.BiliSub = window.BiliSub || {};
window.BiliSub.overlayStyle = `
:host{all:initial;display:block;position:relative;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;--subtitle-size:18px;--surface-alpha:0;--caption-alpha:.9;--surface:247,244,237;--ink:#25231f;--muted:#716c62;--caption:#302d28;--active:#8b3d2e;--highlight:#f1dfcbe6;--outline:#fffaf0b0;--panel:#f7f4ed;--border:#d6d0c4;--hover:#e9e1d3;--accent:#9a4938;outline:none;color:var(--ink);color-scheme:light}
:host([data-theme="night"]){--surface:30,29,26;--ink:#f2ede2;--muted:#b6aea0;--caption:#e8e1d4;--active:#ffe0c7;--highlight:#694430e6;--outline:#151411cc;--panel:#1e1d1a;--border:#49443c;--hover:#39342d;--accent:#e7b69c;color-scheme:dark}
:host([hidden]),[hidden]{display:none!important}
:host([data-mode="inline"]){position:fixed;z-index:2147483646}
*{box-sizing:border-box}button,select,input{font:inherit}button{cursor:pointer;touch-action:manipulation}button,select{color:var(--ink);border:0}
button:focus-visible,select:focus-visible,input:focus-visible,summary:focus-visible,[role="button"]:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button:disabled,input:disabled{opacity:.45;cursor:not-allowed}svg{width:17px;height:17px;display:block;flex-shrink:0}
.card{position:relative;height:100%;isolation:isolate;border-radius:3px;background:rgba(var(--surface),var(--surface-alpha));overflow:hidden}
:host([data-revealed="true"]) .card{box-shadow:inset 0 0 0 1px var(--border)}
.chrome{opacity:0;pointer-events:none;transition:opacity 160ms ease}
:host([data-revealed="true"]) .chrome{opacity:1;pointer-events:auto}
.topbar{position:absolute;top:4px;left:8px;right:8px;height:27px;display:flex;align-items:center;gap:8px;padding:0 6px;background:var(--panel);border-bottom:1px solid var(--border);z-index:2;font-size:11px}
.drag-handle{min-width:0;flex:1;display:flex;align-items:center;gap:6px;align-self:stretch;cursor:grab;touch-action:none;user-select:none}
.drag-handle svg{width:14px;height:14px;color:var(--muted)}.mode{color:var(--ink);white-space:nowrap;font:600 15px Georgia,"SimSun",serif;padding-right:8px;border-right:1px solid var(--border)}.clock{font-variant-numeric:tabular-nums;color:var(--muted)}
.status{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted)}.topbar .icon-button{width:25px;height:25px;min-width:25px}.topbar svg{width:14px;height:14px}
.lyrics{position:absolute;inset:6px 10px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:transparent transparent;padding:2px 1px;text-align:left;font-size:var(--subtitle-size);line-height:1.7;overflow-wrap:anywhere;scroll-behavior:auto}
:host([data-revealed="true"]) .lyrics{inset:32px 10px 43px;scrollbar-color:var(--border) transparent}
.line{display:inline;font:inherit;font-weight:400;letter-spacing:.015em;white-space:pre-wrap;overflow-wrap:anywhere;cursor:pointer;color:var(--caption);border-radius:1px;box-decoration-break:clone;-webkit-box-decoration-break:clone;background:rgba(var(--surface),var(--caption-alpha));padding:.2em .18em;text-shadow:none}
.line.active{color:var(--caption);text-decoration:underline;text-decoration-color:var(--accent);text-decoration-thickness:2px;text-underline-offset:3px}
.line:hover{cursor:pointer}
:host([data-layout="lines"]) .cue-row{display:block;margin-bottom:3px}
.empty,.domline{font-size:var(--subtitle-size);line-height:1.7;color:var(--caption);white-space:pre-wrap;overflow-wrap:anywhere;background:rgba(var(--surface),var(--caption-alpha));display:inline;box-decoration-break:clone;-webkit-box-decoration-break:clone;padding:.2em .18em;text-shadow:none}
.empty{font-size:14px}.lyrics:has(.empty){display:flex;align-items:center;justify-content:center}
.toolbar{position:absolute;bottom:5px;left:50%;transform:translateX(-50%);width:max-content;max-width:calc(100% - 12px);min-height:34px;padding:2px 6px;display:flex;justify-content:center;gap:5px;align-items:center;background:var(--panel);border:1px solid var(--border);border-radius:3px;z-index:2}
.icon-button,.skip,.rate,.window-button,.text-button{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;min-width:28px;border-radius:2px;background:transparent;transition:background 150ms;color:var(--ink);white-space:nowrap}
.icon-button:hover,.skip:hover,.rate:hover,.window-button:hover,.text-button:hover{background:var(--hover)}.skip{padding:0 7px;font-size:12px;font-variant-numeric:tabular-nums}.play{background:var(--ink);color:var(--panel);width:34px}.play:hover{background:var(--active);color:var(--panel)}.rate{padding:0 3px;font-size:12px;width:56px}.rate option{background:var(--panel)}
.window-button{font-size:12px;padding:0 6px}.text-button{font-size:11px;padding:0 5px}.separator{width:1px;height:15px;background:var(--border);margin:0 3px}
.settings-panel{position:absolute;inset:0;background:var(--panel);z-index:3;display:flex;flex-direction:column;overflow:hidden;padding:0 18px}
.settings-header{flex-shrink:0;display:flex;align-items:center;justify-content:space-between;height:47px;border-bottom:1px solid var(--ink);font:600 20px Georgia,"SimSun",serif;letter-spacing:.06em}.settings-header .icon-button{height:30px;width:30px}
.settings-body{overflow:auto;min-height:0;scrollbar-width:thin;padding:12px 0 14px;overscroll-behavior:contain}
.settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 24px}.field{display:block;min-width:0;font-size:12px;color:var(--muted)}.field-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}.value{color:var(--ink);font:13px Consolas,monospace;font-variant-numeric:tabular-nums}
.field input[type="range"]{width:100%;margin:0;accent-color:var(--accent);height:24px;cursor:pointer}.step,.setting-select{width:100%;height:30px;background:transparent;border:1px solid var(--border);color:var(--ink);border-radius:2px;padding:3px 8px;font-size:12px}.setting-select option{background:var(--panel);color:var(--ink)}
.size-fields{display:flex;align-items:center;gap:8px}.size-fields .step{min-width:0}.note{font-size:11px;line-height:1.6;color:var(--muted);margin:14px 0 10px;padding-top:10px;border-top:1px solid var(--border)}.settings-footer{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.diagnostics{font-size:11px;color:var(--muted)}.diagnostics summary{cursor:pointer;width:max-content}.debug{font-size:11px;white-space:pre-wrap;line-height:1.5;margin:4px 0}
:host([data-settings="true"]) .topbar,:host([data-settings="true"]) .toolbar{visibility:hidden}
.resize-handle{position:absolute;z-index:4;touch-action:none}.resize-n,.resize-s{height:10px;left:10px;right:10px;cursor:ns-resize}.resize-n{top:-4px}.resize-s{bottom:-4px}.resize-e,.resize-w{width:10px;top:10px;bottom:10px;cursor:ew-resize}.resize-e{right:-4px}.resize-w{left:-4px}
.resize-ne,.resize-nw,.resize-se,.resize-sw{width:15px;height:15px}.resize-ne{right:-4px;top:-4px;cursor:nesw-resize}.resize-nw{left:-4px;top:-4px;cursor:nwse-resize}.resize-se{right:-4px;bottom:-4px;cursor:nwse-resize}.resize-sw{left:-4px;bottom:-4px;cursor:nesw-resize}
.resize-se:after{content:'';position:absolute;right:6px;bottom:6px;width:7px;height:7px;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);border-radius:1px}
:host([data-manipulating="true"]){user-select:none}:host([data-manipulating="true"]) .drag-handle{cursor:grabbing}
@media(max-width:540px){.settings-panel{padding:0 12px}.settings-grid{gap:14px;grid-template-columns:1fr}.lyrics{left:10px;right:10px}.toolbar{gap:1px;padding:2px}.separator{margin:0 2px}.mode{display:none}.window-button{padding:0 3px}.window-button svg{display:none}.skip{padding:0 4px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
`;
