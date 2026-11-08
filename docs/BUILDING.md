# 桌面应用构建

业务代码使用 Node.js 内置模块；网页库已本地打包。仓库保留运行时许可和来源元数据，运行时二进制不进入 Git 历史。

## Windows

在 Windows 10/11 x64 上准备 Node.js 24 和系统 .NET Framework C# 编译器。将匹配版本的 Windows x64 `node.exe` 放到 `runtime/node.exe`，核对 `runtime/PROVENANCE.json` 的 SHA-256；许可证位于 `runtime/LICENSE`。如主动更换运行时，应同步更新来源、许可和校验记录。

```powershell
node scripts/package-portable.mjs
```

生成的 EXE 包含网页、后台服务和运行时。真实生产路径验证使用 `node scripts/smoke-portable.mjs --archive <新生成的ZIP路径>`；使用独立测试目录和端口，不使用正常身份数据。

## Mac

准备 Python 3 与 Pillow，以及 Node.js。获取经脚本固定摘要校验的两种运行时：

```sh
node scripts/fetch-macos-runtime.mjs
node scripts/package-macos.mjs
```

脚本生成 Apple Silicon 与 Intel 的内部构建包；在 Windows 与两个 Mac 原始构建均完成后，运行 `python scripts/package-final-release.py`，得到 `dist/深入·局域网互传-Windows.zip` 与 `dist/深入·局域网互传-Mac.zip`。Mac 最终包只有一个 APP，通过运行时选择脚本自动识别架构。

若系统 Python 不在脚本预期位置，可设置 PYTHON；直接运行 package-macos.py 时可设置 NODE。运行时二进制与安装包只上传 GitHub Releases。发布前核对包内所有源文件、校验清单和 Mac 执行权限。

签名、公证与真实 Mac 菜单栏和跨设备网络验收需要在对应环境单独完成，跨平台源码测试不能代替。
