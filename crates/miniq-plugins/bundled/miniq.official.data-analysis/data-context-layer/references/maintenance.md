# 维护与刷新

## 何时更新
- 新增核心表/指标；口径变更；发现文档与数据不符；迁移或重构管道

## 半自动刷新
1. 写 `data-context/refresh.py`（或 `.sh`）：重新导出 schema、行数、最大时间戳、主键唯一性、空值率，输出 `data-context/snapshot.json`
2. 与上一版 snapshot 对比：新增/删除列、类型变化、行数异常波动、新枚举值
3. 差异写入 `data-context/CHANGELOG.md`，需要人工判断的列入 README 的“待确认问题”
4. 可结合 `data-quality-audit/scripts/run_checks.py` 的规则文件做每日检查

## 定期运行
- 若用户需要，可用 miniQ 的定时任务功能或系统 cron 定时执行 refresh 脚本；是否启用由用户决定
- 失败时只记录，不自动改写指标定义

## 版本管理
- 建议把 `data-context/` 纳入用户自己的 git 仓库（由用户决定是否提交）
- 指标口径修改时保留旧定义与生效日期，方便解释历史数据
