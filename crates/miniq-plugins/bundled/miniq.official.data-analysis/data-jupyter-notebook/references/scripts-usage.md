# scripts 使用说明：nb_tool.py

Jupyter Notebook 辅助工具，仅依赖 Python 3.9+ 标准库（不需要安装 nbformat）。

## 子命令

```bash
S=scripts/nb_tool.py
python3 $S scaffold analysis.ipynb --template analysis --title "Q3 经营分析"   # 也可选 tutorial / diagnostic；加 --force 覆盖已有文件
python3 $S validate analysis.ipynb            # 加 --json 输出机器可读结果
python3 $S run analysis.ipynb                 # 可用 -o 指定输出、--timeout 600、--kernel python3、--fallback
python3 $S strip analysis.ipynb               # 原地清空输出；可用 -o 另存，--keep-count 保留执行计数
python3 $S to-py analysis.ipynb -o analysis.py
```

### scaffold

生成 nbformat v4.5 格式的 notebook（带 cell id 和 kernelspec）。章节依次为 **摘要 / 背景与方法 / 数据 / 结果 / 结论**，并包含带 `parameters` 标签的参数单元格（兼容 papermill），默认使用相对路径。

- `analysis`：通用分析，包含数据质量检查单元
- `tutorial`：教程，包含演示数据、分步说明和练习区
- `diagnostic`：异常诊断，包含基线期/对比期参数、维度拆解和假设验证表

### validate

| 级别 | 检查内容 |
|---|---|
| 错误 | 缺少顶层字段、nbformat 不是 v4、未知的 cell_type、cell 缺少字段、cell id 重复、存在 error 输出、源码或输出中疑似有密钥（AWS/OpenAI/GitHub/Slack/Google key、私钥、`password="..."` 这类硬编码凭据、带密码的连接串） |
| 警告 | 缺少 kernelspec、4.5+ 版本缺少 cell id、执行计数乱序或重复、单个 cell 输出超过 500KB、硬编码绝对路径（`/Users`、`/home`、`C:\` 等） |
| 提示 | 执行计数不连续、有代码单元未执行 |

发现错误时退出码为 3，否则为 0。

### run

- 若有 `jupyter nbconvert`：执行 `nbconvert --to notebook --execute`，结果写入 `<名>.executed.ipynb`
- 否则（或指定了 `--fallback`）**降级执行**：
  1. 把代码单元抽取到临时 `.py` 文件，放在 notebook 所在目录，并以该目录为工作目录
  2. magic（`%`）和 shell（`!`）行会被注释掉
  3. 提供一个简易的 `display()`（相当于 print）
  4. 用当前 python3 执行
  5. 报告 stdout/stderr，以及出错的 cell 编号
  6. 执行结果**不写回** notebook；临时文件自动删除
  7. 成功时退出码为 **2**（表示已降级），失败时为 1
  8. 会提示如何安装完整环境：`python3 -m pip install --user nbconvert nbclient ipykernel`

### strip / to-py

- `strip`：清空 outputs 和 execution_count，同时删除 `execution`/`collapsed`/`scrolled` 元数据和 widgets 状态，适合提交到 git 前使用
- `to-py`：markdown 转为注释，代码单元之间用 `# %%` 分隔（VS Code 和 Jupytext 可识别），magic 行会被注释掉

## 已知限制

- 降级执行时所有单元格在同一个进程中顺序运行，与内核行为接近，但不支持 magic、shell 命令和富输出（图片不会保存）
- 密钥检测基于正则表达式，可能误报或漏报，发布前仍需人工复核
- validate 不检查 JSON Schema 的全部细节（例如 output 各字段的类型）
