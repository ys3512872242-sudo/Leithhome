# Leithhome 换装生产线

网页采用固定的 1024×1024 PNG 坐标系。所有衣物必须保持原画布尺寸和人物位置；不要裁边、缩放或只导出衣服的包围框。

## 推荐流程：VNCCS → See-through → 衣物工坊

1. 在 VNCCS 中以 Susie 固定人物图为角色参考，只改变服装描述，不改变人物、正面站姿、镜头和画布。
2. 生成一张 1024×1024、穿着新衣的完整 Susie。先检查脸、头发、双手、姿势是否仍与固定人物一致；漂移明显的图直接重生成。
3. 把合格的完整人物图送入 ComfyUI See-through Decompose。
4. 用 SeeThrough Save PSD 导出 PSD；不要先裁切画布。
5. 双击 `Open-Wardrobe-Studio.command`，把 PSD 或 PSD.ZIP 拖进去。
6. 工坊会只列出服装语义层：`topwear`、`bottomwear`、`dress`、`legwear`、`footwear`、`headwear`。
7. 检查缩略图，修正类别、商品名和价格，然后点击“写入衣物目录”。
8. 刷新 Leithhome，新商品会出现在“购物 → 衣装货架”；购买后进入衣橱试穿。

See-through 是拆层工具，不是衣服设计器。VNCCS 负责角色一致性和服装生成，See-through 只负责从合格成图中提取透明衣物层。

## 最短流程：直接透明 PNG

如果 ComfyUI 工作流能直接输出只有衣物的 RGBA PNG，可以跳过 See-through，直接拖进衣物工坊。文件仍必须是 1024×1024，并与 Susie 对齐。建议用语义名命名，例如：

- `topwear-cream-cardigan.png`
- `bottomwear-black-skirt.png`
- `dress-wine-red.png`
- `legwear-white-socks.png`
- `footwear-loafers.png`
- `headwear-beret.png`

## 上架前验收

- 画布必须为 1024×1024。
- PNG 必须带透明通道，背景透明。
- 只保留该商品需要的像素，不应残留脸、头发、皮肤或旧衣服。
- 上衣和下装应能分别穿；连衣裙使用 `dress`，会同时替换上衣和下装。
- 衣服边缘不能出现明显白边、黑边或半透明人物轮廓。
- 图片位置必须与固定人物完全重合。

工坊现在会自动拒绝画布尺寸错误和没有透明通道的 PNG，避免无效商品写入目录。

## 分层类别

- `topwear` → 上衣
- `bottomwear` → 下装
- `dress` / `onepiece` → 连衣裙
- `legwear` → 袜子、丝袜
- `footwear` → 鞋子
- `headwear` → 帽子

脸、眼睛、头发和身体属于固定人物包，不会作为商品上架。
