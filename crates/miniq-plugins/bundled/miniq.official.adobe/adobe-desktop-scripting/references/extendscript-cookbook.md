# ExtendScript 速查与定制脚本模板

> 适用于 Photoshop / Illustrator 的 ExtendScript（ES3）。所有脚本都通过 `scripts/run_jsx.sh` 执行，参数从全局对象 `ARGS` 读取（值都是字符串）。

## 1. ES3 语法限制
- 只能用 `var`，没有 `let`/`const`、箭头函数、模板字符串、`Array.prototype.forEach/map`，也没有原生 `JSON`。
- 返回值：脚本最后一个表达式的值会作为 `osascript` 的输出。建议拼成 `"ok=N;fail=M;errors=..."` 这种字符串。
- 路径：`new File(ARGS.input)`、`new Folder(ARGS.output)`；`Folder.create()` 创建目录；列文件用 `folder.getFiles(/\.(jpe?g|png|tif|psd)$/i)`。
- 每个文件单独包一层 `try { ... } catch (e) { errors.push(f.name + ":" + e.message); }`，单个失败不中断整批。

## 2. Photoshop 常用 API
| 需求 | 代码 |
|---|---|
| 关闭弹窗 | `app.displayDialogs = DialogModes.NO;` |
| 打开 / 关闭 | `var d = app.open(file); ... d.close(SaveOptions.DONOTSAVECHANGES);` |
| 播放动作 | `app.doAction("动作名", "动作组名");` |
| 按长边缩放 | `d.resizeImage(UnitValue(w,"px"), UnitValue(h,"px"), 72, ResampleMethod.BICUBICSHARPER);` |
| 转 sRGB | `d.convertProfile("sRGB IEC61966-2.1", Intent.RELATIVECOLORIMETRIC, true, false);` |
| 另存 JPG | `var o = new JPEGSaveOptions(); o.quality = 10; d.saveAs(outFile, o, true);` |
| 另存 PNG | `d.saveAs(outFile, new PNGSaveOptions(), true);` |
| 改文字图层 | `d.artLayers.getByName("Title").textItem.contents = ARGS.title;` |
| 拼合 | `d.flatten();` |

### 替换智能对象内容（样机回退，见 `adobe-create-mockups`）
```javascript
function replaceSO(layer, path) {
  app.activeDocument.activeLayer = layer;
  var desc = new ActionDescriptor();
  desc.putPath(charIDToTypeID("null"), new File(path));
  executeAction(stringIDToTypeID("placedLayerReplaceContents"), desc, DialogModes.NO);
}
// 调用示例：replaceSO(d.artLayers.getByName("Design"), ARGS.logo);
```
注意：智能对象图层可能在图层组里，需要递归遍历 `d.layerSets`。

## 3. Illustrator 常用 API
| 需求 | 代码 |
|---|---|
| 画板数量 | `doc.artboards.length` |
| 切换画板 | `doc.artboards.setActiveArtboardIndex(i);` |
| 导出 PNG | `var o = new ExportOptionsPNG24(); o.artBoardClipping = true; o.horizontalScale = o.verticalScale = 200; doc.exportFile(f, ExportType.PNG24, o);` |
| 导出 SVG | `ExportOptionsSVG` + `ExportType.SVG` |
| 替换文字 | `doc.textFrames.getByName("Title").contents = ARGS.title;` |
| 关闭 | `doc.close(SaveOptions.DONOTSAVECHANGES);` |

## 4. 定制脚本骨架
```javascript
#target photoshop
(function () {
  app.displayDialogs = DialogModes.NO;
  var inF = new Folder(ARGS.input), outF = new Folder(ARGS.output);
  if (!outF.exists) outF.create();
  var files = inF.getFiles(/\.(jpe?g|png|tif|psd)$/i), ok = 0, errs = [];
  for (var i = 0; i < files.length; i++) {
    var d = null;
    try {
      d = app.open(files[i]);
      // …处理…
      var out = new File(outF.fsName + "/" + files[i].name.replace(/\.[^.]+$/, "") + ".jpg");
      if (out.exists && ARGS.overwrite !== "1") { errs.push(files[i].name + ":exists"); }
      else { var o = new JPEGSaveOptions(); o.quality = 10; d.saveAs(out, o, true); ok++; }
    } catch (e) { errs.push(files[i].name + ":" + e.message); }
    finally { if (d) d.close(SaveOptions.DONOTSAVECHANGES); }
  }
  return "ok=" + ok + ";fail=" + errs.length + ";errors=" + errs.join("|");
})();
```

## 5. 安全清单
- 写入前确认输出目录，不要与输入目录相同；默认不覆盖已有文件。
- 不执行来源不明的 .jsx/.atn；运行前向用户说明脚本会读写哪些路径。
- 批量处理超过 200 个文件时，建议分批进行，并先跑 1–2 个样张验证。
