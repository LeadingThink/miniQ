# miniQ App 备案信息（安卓 / iOS）

给负责备案的同事：下面的值都是从正式签名安装包里直接取出来的，和上架包一致，可以直接复制粘贴。

先说清楚平台范围：**App 备案只针对移动应用，需要填的是安卓和 iOS 两套。** Windows、macOS、Linux 是我们用 Tauri 打的桌面客户端，不属于 App 备案的填写对象；和它相关的是下载站的网站备案。桌面端的标识我放在最后一节，方便对照，不用往 App 特征信息里填。目前没有鸿蒙版本。

## 一、安卓平台

| 字段 | 填写内容 |
| --- | --- |
| App 包名 | `com.leadingthink.miniq` |
| 签名 MD5 值 | `f0ac934a748ac9a77e5e6e517fed92d3` |

公钥（一长串十六进制，粘贴时保持连续，不要换行、不要加空格、不要带 `0x`）：

```
c2fb386a23f01419e1b8f60ce7fde42ab76fc46426f2749023343e1bda4a1f6113d7729f0f594ef02ca82441d4c2abf1981bcebcb1ac5a42e05c76809f2d0785f4eeca96815d2cec1ec4e32ba9da456e8b858bd4988e857e344e17def751ad3f6c5b2e439177e58bc255fcd5914eab2e141a4192e8428664dc6bff9473ffac47ff53839edf145db4015c1caf1cfe4c06f5224da522e1b488a6f600cdb7b8b51c50101f63428931e6c92128e6ff49f6a1f3d1b5ab28e6f16c51eb0ad7ead637291f2b62197c77fe7eb5a02f8e1412311f0539407338203cb630916ce50f371dbcca76ce293c64cc3cff108a7c7842a1aa49c7fefc3809e9eba39df121b096f8bc766ceb06066bd696b9bdf17ebc1385ef3098c5ef28a0bb9aac18a0f3f692d77a7289762346f2a44089b05cee4606852b4502d802e363722b7a26a3cb48002774d8261d074ac87c66a5d88cce5e8cd2502e947e1b4093dabb4542827cdba7673154454d92defd31bc13bce35e9d0235cf7116bf2edeaccf522b3b0a4ab41a4d3470f059f5936b379e3c837bfa6c8a21f57c5c66d614a5d98cec76a3f4e313a037b807e58ffc685875af2c08534d89402fa44bb6c2d83e15c3ebb4232664a37fe67800f7bc0f7ff252fd5c7dec66534666f26c5098f6b5048368857f7ffa976bf04a1f909674daa06c221e236fd41146a2056a13859e71293236dd3889b2f94459
```

这串是签名证书里 4096 位 RSA 公钥的模数，共 1024 个十六进制字符，备案系统要的就是它。

取值依据：证书主体 `CN=miniQ Android Release, O=LeadingThink`，SHA-256 指纹 `05d22724d2ad383290390bc1dbfb25e53940dd8fe2c45fabc065d2f0d600220c`。我在 0.1.46、0.1.94、0.1.107 三个正式包里分别提取过，模数和 MD5 完全一致，说明一直用的同一把发布密钥；当前安卓正式版是 0.1.116（versionCode 116，tag `android-v0.1.116`）。

## 二、iOS 平台

| 字段 | 填写内容 |
| --- | --- |
| Bundle ID | `com.leadingthink.miniq` |
| 签名 SHA1 值 | `e82d72dbd1738d60cfba4f08f2a45022447bebd8` |

公钥（证书里的公共密钥，Base64）：

```
MIIBCgKCAQEAodIaAL9EjLy/H8Tm4A+2WhF/gIz1O1L7giURf09nDnSmvlkV7GYdEpgGVlpu7xAI2MIcG5fDIjyeVw+nAS5xB0UO79tYDpJP4eP8lEHbgw+SiGHER5B4PbNrrDUpjgLN//WHJ5JPxkOi4PibBdCz5tvZj0ONC50ycgeRoSR06Mt+x1I2yrxRzopR4paWxL+QHJdMFEbuyn8kKxewf1P0ezt9ZPHfmcAURqTefNlaOpOj1qACdyepzalmwxvbbQM93m/9s32QRo13fDdYqt+Ax5UKLmduewAZp28wD3F/+iWUF3R0OA6X+TMGmtjU5qYVxahx/c+sB2rYcvL/j7yvTQIDAQAB
```

如果备案系统提示公钥只能填十六进制，就换成这张证书的模数：

```
a1d21a00bf448cbcbf1fc4e6e00fb65a117f808cf53b52fb8225117f4f670e74a6be5915ec661d129806565a6eef1008d8c21c1b97c3223c9e570fa7012e7107450eefdb580e924fe1e3fc9441db830f928861c44790783db36bac35298e02cdfff58727924fc643a2e0f89b05d0b3e6dbd98f438d0b9d32720791a12474e8cb7ec75236cabc51ce8a51e29696c4bf901c974c1446eeca7f242b17b07f53f47b3b7d64f1df99c01446a4de7cd95a3a93a3d6a0027727a9cda966c31bdb6d033dde6ffdb37d90468d777c3758aadf80c7950a2e676e7b0019a76f300f717ffa2594177474380e97f933069ad8d4e6a615c5a871fdcfac076ad872f2ff8fbcaf4d
```

取值依据：取自最近一次 TestFlight 构建 1.7（build 6）的导出包，描述文件 `miniQ App Store Push`，App ID 为 `W5M6Q4SAV7.com.leadingthink.miniq`，Apple 团队 ID `W5M6Q4SAV7`。SHA1 在包的代码签名里也核到同一个证书值，证书有效期到 2027-09-12。

## 三、App 图标

备案系统要上传的应用图标，我导出了一份现成的，直接传这个：

- 文件：`docs/app-icon-512.png`
- 规格：512×512、PNG、无透明背景（307 KB 左右）
- 画面：白色圆角底 + 蓝紫渐变的小写 q 标志，和 App Store、各安卓商店里的一致

如果表单提示需要别的尺寸，仓库里的原图都在，不用另找：

| 用途 | 文件 | 尺寸 |
| --- | --- | --- |
| 安卓最高清档 | `apps/desktop/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png` | 192×192 |
| iOS 商店 1024 | `apps/desktop/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png` | 1024×1024 |
| 桌面端通用 | `apps/desktop/src-tauri/icons/icon.png`（源图 `source.png`） | 512×512（源图 1254×1254） |

图标要和应用商店里显示的一致，换设计就要跟着换备案材料。

## 四、填写时要注意的几点

- 包名和 Bundle ID 必须和应用商店里的包完全一致，一个包名对应一个 App。以后新增平台或改包名，要单独新增备案。
- 公钥、MD5、SHA1 都来自签名证书。如果换签名密钥（比如安卓改用 Google Play 应用签名、苹果证书到期后换新证书），这些值会变，需要做变更备案。
- MD5 是 32 位、SHA1 是 40 位，纯十六进制，不要带冒号分隔，大小写都可以。
- 备案系统里点「验证」时，它校验的是应用商店上架包的信息，所以上架包必须用上面这套证书签名。

## 五、桌面端（不用填，供对照）

| 项目 | 内容 |
| --- | --- |
| 应用名 | miniQ |
| 应用标识（Tauri identifier / macOS Bundle Identifier） | `dev.miniq.desktop` |
| 当前版本 | 0.1.229 |
| 支持系统 | Windows x64（NSIS 安装包）、macOS Apple 芯片与 Intel（dmg）、Linux x86_64（deb / AppImage） |
| 下载分发 | `https://oss.zaiwen.top/releases/miniq/`，镜像 `https://github.com/LeadingThink/miniQ-releases` |

桌面版不需要 App 特征信息的包名、公钥和 MD5。如果同时要办网站备案，用的是这些域名对应的站点信息，和 App 备案是两张表。
