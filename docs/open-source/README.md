# 开源工程说明

这些文档面向贡献者、审查者和未来接手维护的人，描述当前公开主线的实际工程边界，不替代 `docs/product/` 的产品定义，也不把建议写成已经实现。

- [架构与信任边界](architecture.md)
- [关键流程](flows.md)
- [权限矩阵](permissions.md)
- [配置、变量与数据](variables.md)
- [测试覆盖与发布门槛](tests.md)
- [公开范围清单](public-scope.md)

当前正式入口是 `apps/dock-extension`。旧版插件、原型、内部看板、Cairn 正文和第三方参考不属于公开运行路径；见 [公开范围清单](public-scope.md)。
