# 领域文档目录

> 上级目录：[工程文档](../index.md)

## 范围

会话在磁盘上的含义、索引规则，以及侧栏「同一对话」的产品语义（与 pi fork 文件模型对齐）。

## 文档

- [会话索引与布局](session_indexing.md)：两种落盘布局、cwd 可信来源、pending 会话、大文件 head/命名回扫。读取时机：改 `sessionIndex.ts`、`config.ts` 会话目录参数时。
