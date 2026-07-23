# 衣物收件箱

这里可以临时放 See-through 导出的 `.psd` 或 `.psd.zip`。

日常使用不需要手动整理文件：双击项目根目录的 `Open-Wardrobe-Studio.command`，在浏览器中选择文件、填写名称和价格，工坊会自动完成：

- 读取 PSD 图层；
- 识别上衣、下装、鞋袜、帽子与配饰；
- 输出透明 PNG 和商品缩略图；
- 更新 `wardrobe/catalog.json` 与 `wardrobe/catalog.js`；
- 让 Leithhome 下次刷新时发现新商品。

原始 ZIP 不会被移动或删除。
