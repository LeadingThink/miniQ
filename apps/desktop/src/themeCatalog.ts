// 配色来自 zaiwenai app/web theme-catalog.ts；保留 miniQ 的六套既有配色。
// 静态配色独立于背景库：不引入纹理、角色或动态资源。
export type ThemeMode = "light" | "dark";
export const themeCategories = [
  {
    "id": "classic",
    "name": "基础",
    "description": "安静、耐看的日常工作界面"
  },
  {
    "id": "nature",
    "name": "自然",
    "description": "森林、海岸、旷野与植物色彩"
  },
  {
    "id": "storybook",
    "name": "手绘幻想",
    "description": "原创绘本气质与轻叙事场景"
  },
  {
    "id": "playful",
    "name": "萌趣",
    "description": "轻快糖果色与电气伙伴想象"
  },
  {
    "id": "paper",
    "name": "纸张线稿",
    "description": "方格、稿纸、铅笔与编辑部质感"
  },
  {
    "id": "retro",
    "name": "复古",
    "description": "胶片、唱片、报刊与旧式设备"
  },
  {
    "id": "future",
    "name": "未来",
    "description": "终端、霓虹、轨道与数字界面"
  },
  {
    "id": "seasonal",
    "name": "节气",
    "description": "四季、天气与东方时令配色"
  },
  {
    "id": "night",
    "name": "深夜",
    "description": "适合低照度环境的沉浸暗色"
  }
] as const;
export type ThemeCategoryId = (typeof themeCategories)[number]["id"];
export type ThemeDefinition = {
  id: string; name: string; description: string; mode: ThemeMode;
  category: ThemeCategoryId;
  /** 新偏好尚无另一明暗选择时使用的配色；已有两侧偏好优先。 */
  pair: string;
  preview: { page: string; sidebar: string; surface: string; accent: string; text: string };
};

export const themeCatalog = [
  {"id":"jade","name":"浅玉","description":"纸白与松石绿","mode":"light","pair":"night","preview":{"page":"#f4f5f1","sidebar":"#ecefe9","surface":"#ffffff","accent":"#14775f","text":"#17191d"},"category":"classic"},
  {"id":"snow","name":"素白","description":"中性灰白与系统蓝","mode":"light","pair":"slate","preview":{"page":"#f5f5f7","sidebar":"#ececef","surface":"#ffffff","accent":"#0066cc","text":"#1d1d1f"},"category":"classic"},
  {"id":"amber","name":"琥珀","description":"暖纸色与琥珀强调","mode":"light","pair":"graphite","preview":{"page":"#f7f6f2","sidebar":"#efede6","surface":"#fffefd","accent":"#a96012","text":"#28231d"},"category":"classic"},
  {"id":"night","name":"夜墨","description":"安静的深绿灰","mode":"dark","pair":"jade","preview":{"page":"#181c1a","sidebar":"#202522","surface":"#252a27","accent":"#32a982","text":"#f2f5f3"},"category":"classic"},
  {"id":"slate","name":"深空","description":"中性深灰与亮蓝","mode":"dark","pair":"snow","preview":{"page":"#1c1c1e","sidebar":"#232326","surface":"#2c2c2e","accent":"#4c9dff","text":"#f5f5f7"},"category":"classic"},
  {"id":"graphite","name":"石墨","description":"深灰与橙色强调","mode":"dark","pair":"amber","preview":{"page":"#161819","sidebar":"#202326","surface":"#282c2f","accent":"#e17632","text":"#f4f3f1"},"category":"classic"},
  {"id":"rose","name":"玫瑰","description":"克制的玫红与雾粉","category":"classic","mode":"light","preview":{"page":"#fbf4f6","sidebar":"#f5e9ed","surface":"#fffafb","accent":"#b13c62","text":"#291a20"},"pair":"graphite"},
  {"id":"grid","name":"线格","description":"清晰的蓝灰工作台","category":"classic","mode":"light","preview":{"page":"#f4f7fa","sidebar":"#e9eef3","surface":"#ffffff","accent":"#356a96","text":"#17212b"},"pair":"slate"},
  {"id":"ocean","name":"海雾","description":"海蓝与冷调白","category":"classic","mode":"light","preview":{"page":"#f1f7f8","sidebar":"#e4eff1","surface":"#fbfefe","accent":"#16758a","text":"#13272c"},"pair":"slate"},
  {"id":"forest","name":"青森","description":"杉木绿与薄荷灰","category":"classic","mode":"light","preview":{"page":"#f2f6f3","sidebar":"#e5ede8","surface":"#fbfdfb","accent":"#356b4d","text":"#18251e"},"pair":"night"},
  {"id":"ink","name":"墨韵","description":"黑白灰的专注阅读","category":"classic","mode":"light","preview":{"page":"#f3f3f2","sidebar":"#e8e8e6","surface":"#fdfdfc","accent":"#343a3c","text":"#151718"},"pair":"slate"},
  {"id":"blueprint","name":"蓝图","description":"深蓝线格与青色标记","category":"classic","mode":"dark","preview":{"page":"#0b1a24","sidebar":"#102532","surface":"#163241","accent":"#45b8c7","text":"#edf9fb"},"pair":"snow"},
  {"id":"sky","name":"晴空","description":"明快的天蓝与云白","category":"classic","mode":"light","preview":{"page":"#f3f7fc","sidebar":"#e7eef7","surface":"#ffffff","accent":"#3778c2","text":"#172235"},"pair":"slate"},
  {"id":"iris","name":"鸢尾","description":"低饱和紫与冷灰","category":"classic","mode":"light","preview":{"page":"#f6f4f8","sidebar":"#ece8f1","surface":"#fefcff","accent":"#735a91","text":"#241d2c"},"pair":"slate"},
  {"id":"moss-path","name":"苔径","description":"雨后石阶与湿润苔色","category":"nature","mode":"light","preview":{"page":"#f1f4ed","sidebar":"#e3eadf","surface":"#fbfcf8","accent":"#55734d","text":"#1d291b"},"pair":"night"},
  {"id":"pine-wind","name":"松风","description":"冷杉、山风与清晨薄雾","category":"nature","mode":"light","preview":{"page":"#eef4f1","sidebar":"#dfe9e4","surface":"#fafdfb","accent":"#2f6f5c","text":"#162820"},"pair":"night"},
  {"id":"reed-bank","name":"芦岸","description":"河岸灰绿与亚麻白","category":"nature","mode":"light","preview":{"page":"#f5f4ed","sidebar":"#eae8dc","surface":"#fffef8","accent":"#6a7650","text":"#292b20"},"pair":"graphite"},
  {"id":"coral-tide","name":"珊瑚潮","description":"浅海青与珊瑚红","category":"nature","mode":"light","preview":{"page":"#f1f8f7","sidebar":"#e0eeeb","surface":"#fbfffe","accent":"#d45c55","text":"#17302f"},"pair":"graphite"},
  {"id":"glacier","name":"冰川","description":"冰蓝裂隙与雪原白","category":"nature","mode":"light","preview":{"page":"#f1f7fa","sidebar":"#e2eef4","surface":"#fcfeff","accent":"#2c86a8","text":"#132b37"},"pair":"slate"},
  {"id":"canyon","name":"峡谷","description":"岩层红与风化砂岩","category":"nature","mode":"light","preview":{"page":"#f8f2ed","sidebar":"#eee2d8","surface":"#fffaf6","accent":"#a64d36","text":"#352018"},"pair":"graphite"},
  {"id":"bamboo-rain","name":"竹雨","description":"新竹绿与细密雨线","category":"nature","mode":"light","preview":{"page":"#f2f7f2","sidebar":"#e3eee4","surface":"#fcfffc","accent":"#2f7d54","text":"#17291e"},"pair":"night"},
  {"id":"lavender-field","name":"薰衣草田","description":"灰紫花田与晨光","category":"nature","mode":"light","preview":{"page":"#f7f4f9","sidebar":"#ece7f1","surface":"#fffaff","accent":"#8064a2","text":"#2b2332"},"pair":"slate"},
  {"id":"desert-bloom","name":"沙漠花","description":"矿物粉与仙人掌绿","category":"nature","mode":"light","preview":{"page":"#f8f3ec","sidebar":"#eee5da","surface":"#fffaf3","accent":"#3f8067","text":"#33261d"},"pair":"night"},
  {"id":"aurora-lake","name":"极光湖","description":"冷夜湖面与极光绿","category":"nature","mode":"dark","preview":{"page":"#09191c","sidebar":"#10262a","surface":"#163338","accent":"#55d6a7","text":"#ecfffa"},"pair":"jade"},
  {"id":"volcanic-ash","name":"火山灰","description":"黑岩、余烬与低饱和红","category":"nature","mode":"dark","preview":{"page":"#181616","sidebar":"#231f1e","surface":"#2c2725","accent":"#e36f4a","text":"#fff2ed"},"pair":"amber"},
  {"id":"peach-orchard","name":"桃园","description":"桃花粉与枝叶青","category":"nature","mode":"light","preview":{"page":"#fff5f4","sidebar":"#f5e9e6","surface":"#fffdfb","accent":"#c65068","text":"#352126"},"pair":"graphite"},
  {"id":"wind-meadow","name":"风之原野","description":"风车、草坡与大片留白","category":"storybook","mode":"light","preview":{"page":"#f5f7ed","sidebar":"#e7eddf","surface":"#fffef8","accent":"#4d8b68","text":"#243024"},"pair":"night"},
  {"id":"cloud-post","name":"云上邮局","description":"云朵、邮戳与天青纸张","category":"storybook","mode":"light","preview":{"page":"#f3f8fb","sidebar":"#e4eff5","surface":"#ffffff","accent":"#3f7faa","text":"#20303b"},"pair":"slate"},
  {"id":"forest-station","name":"森林车站","description":"木牌、小站与深林绿","category":"storybook","mode":"light","preview":{"page":"#f2f5ed","sidebar":"#e2e9dd","surface":"#fbfdf8","accent":"#4d7451","text":"#20291e"},"pair":"night"},
  {"id":"flying-workshop","name":"飞行工坊","description":"黄铜零件与手绘蓝图","category":"storybook","mode":"light","preview":{"page":"#f7f3e9","sidebar":"#ebe4d4","surface":"#fffdf6","accent":"#8b5b24","text":"#30271d"},"pair":"graphite"},
  {"id":"lamp-house","name":"雨夜灯屋","description":"窗灯、雨线与深青夜色","category":"storybook","mode":"dark","preview":{"page":"#0f1c20","sidebar":"#17292e","surface":"#20363b","accent":"#f0b84d","text":"#f6fbfa"},"pair":"amber"},
  {"id":"moon-library","name":"月光图书馆","description":"书页、月影与静谧蓝紫","category":"storybook","mode":"dark","preview":{"page":"#121526","sidebar":"#1b2034","surface":"#242b42","accent":"#a9a0ff","text":"#f5f3ff"},"pair":"snow"},
  {"id":"little-planet","name":"小小星球","description":"轨道线与温柔宇宙色","category":"storybook","mode":"light","preview":{"page":"#f5f4fb","sidebar":"#e9e7f3","surface":"#fefcff","accent":"#6f64bd","text":"#26223b"},"pair":"slate"},
  {"id":"tea-clock","name":"茶时钟","description":"红茶、钟面与旧纸张","category":"storybook","mode":"light","preview":{"page":"#f8f3e8","sidebar":"#eee5d5","surface":"#fffaf0","accent":"#9b5a31","text":"#35281d"},"pair":"graphite"},
  {"id":"whale-letter","name":"鲸鱼来信","description":"海面邮简与鲸蓝","category":"storybook","mode":"light","preview":{"page":"#eff7f9","sidebar":"#dfedf1","surface":"#fbfeff","accent":"#25758f","text":"#18313a"},"pair":"slate"},
  {"id":"seed-airship","name":"种子飞船","description":"植物舱与轻盈机械线稿","category":"storybook","mode":"light","preview":{"page":"#f3f7ef","sidebar":"#e5eddf","surface":"#fcfff9","accent":"#557d3e","text":"#263120"},"pair":"graphite"},
  {"id":"snow-cabin","name":"雪原木屋","description":"雪白、木色与炉火橙","category":"storybook","mode":"light","preview":{"page":"#f4f7f8","sidebar":"#e7edef","surface":"#ffffff","accent":"#b85f32","text":"#2d2824"},"pair":"graphite"},
  {"id":"midnight-carousel","name":"午夜旋转台","description":"深紫夜幕与金色灯点","category":"storybook","mode":"dark","preview":{"page":"#171225","sidebar":"#211a31","surface":"#2b233d","accent":"#e2b85c","text":"#fff8e8"},"pair":"amber"},
  {"id":"lemon-spark","name":"柠檬电波","description":"柠檬黄与清爽电光蓝","category":"playful","mode":"light","preview":{"page":"#fffbea","sidebar":"#f5f0cf","surface":"#fffef7","accent":"#e0a800","text":"#2f2a16"},"pair":"graphite"},
  {"id":"spark-buddy","name":"闪电团子","description":"圆润图形与活力电气感","category":"playful","mode":"light","preview":{"page":"#fff8db","sidebar":"#f4eebd","surface":"#fffdf2","accent":"#376dd6","text":"#282615"},"pair":"slate"},
  {"id":"mint-soda","name":"薄荷汽水","description":"气泡点与薄荷青","category":"playful","mode":"light","preview":{"page":"#effbf8","sidebar":"#dcf1ec","surface":"#fbfffe","accent":"#168b75","text":"#15312b"},"pair":"night"},
  {"id":"berry-milk","name":"莓果牛奶","description":"莓红、奶白与柔软圆点","category":"playful","mode":"light","preview":{"page":"#fff3f6","sidebar":"#f8e3e9","surface":"#fffafd","accent":"#c33d68","text":"#3a2029"},"pair":"graphite"},
  {"id":"orange-catnap","name":"橘色午睡","description":"暖橙、奶油与慵懒线条","category":"playful","mode":"light","preview":{"page":"#fff6e9","sidebar":"#f5ead7","surface":"#fffdf8","accent":"#d66b28","text":"#3b281a"},"pair":"graphite"},
  {"id":"grape-jelly","name":"葡萄果冻","description":"透明紫与弹跳几何","category":"playful","mode":"light","preview":{"page":"#f8f2ff","sidebar":"#eee3f7","surface":"#fffaff","accent":"#8755bd","text":"#2e203b"},"pair":"slate"},
  {"id":"blue-bubble","name":"蓝莓气泡","description":"蓝紫气泡与清亮白","category":"playful","mode":"light","preview":{"page":"#f1f5ff","sidebar":"#e2e9f8","surface":"#fbfdff","accent":"#4b6fc8","text":"#1d2944"},"pair":"slate"},
  {"id":"melon-day","name":"蜜瓜日","description":"蜜瓜绿与果肉橙","category":"playful","mode":"light","preview":{"page":"#f5faea","sidebar":"#e7f0d4","surface":"#fffef6","accent":"#e0713c","text":"#29301c"},"pair":"graphite"},
  {"id":"candy-check","name":"糖纸格","description":"彩色方格与糖纸反光感","category":"playful","mode":"light","preview":{"page":"#fff6f2","sidebar":"#f4e7e2","surface":"#fffdfb","accent":"#d14f64","text":"#382428"},"pair":"graphite"},
  {"id":"pixel-pet","name":"像素伙伴","description":"像素网格与荧光绿色","category":"playful","mode":"dark","preview":{"page":"#101914","sidebar":"#18241d","surface":"#213028","accent":"#72dd83","text":"#effff1"},"pair":"jade"},
  {"id":"arcade-pop","name":"街机波普","description":"深靛底上的桃红与青","category":"playful","mode":"dark","preview":{"page":"#171426","sidebar":"#211c34","surface":"#2c2542","accent":"#ff618e","text":"#fff4fa"},"pair":"amber"},
  {"id":"rainbow-pencil","name":"彩铅盒","description":"多彩标记与素描纸","category":"playful","mode":"light","preview":{"page":"#f8f7f2","sidebar":"#eceae1","surface":"#fffefa","accent":"#4e79bd","text":"#292823"},"pair":"slate"},
  {"id":"notebook-blue","name":"蓝线笔记","description":"横线纸与蓝墨水","category":"paper","mode":"light","preview":{"page":"#f8faf8","sidebar":"#edf1ef","surface":"#ffffff","accent":"#376fa6","text":"#20272d"},"pair":"slate"},
  {"id":"architect","name":"建筑方格","description":"毫米方格与工程红标","category":"paper","mode":"light","preview":{"page":"#f5f7f5","sidebar":"#e8ece9","surface":"#fdfefd","accent":"#b94c3d","text":"#202522"},"pair":"graphite"},
  {"id":"pencil-margin","name":"铅笔页边","description":"石墨线与留白稿纸","category":"paper","mode":"light","preview":{"page":"#f7f6f1","sidebar":"#ebe9e1","surface":"#fffef9","accent":"#4e5960","text":"#252725"},"pair":"slate"},
  {"id":"editorial-red","name":"编辑红笔","description":"校样纸与编辑批注红","category":"paper","mode":"light","preview":{"page":"#faf8f3","sidebar":"#efebe2","surface":"#fffefa","accent":"#ba3e38","text":"#2c2925"},"pair":"graphite"},
  {"id":"legal-pad","name":"黄页便笺","description":"淡黄纸与深蓝墨迹","category":"paper","mode":"light","preview":{"page":"#fffbea","sidebar":"#f2edce","surface":"#fffef4","accent":"#315c8a","text":"#2b291d"},"pair":"slate"},
  {"id":"kraft-note","name":"牛皮纸","description":"纸纤维与深咖啡墨色","category":"paper","mode":"light","preview":{"page":"#f4ead8","sidebar":"#e6d8c1","surface":"#fbf3e5","accent":"#79522f","text":"#34281c"},"pair":"graphite"},
  {"id":"receipt-roll","name":"票据卷","description":"热敏纸灰与收银绿","category":"paper","mode":"light","preview":{"page":"#f6f7f4","sidebar":"#e9ebe6","surface":"#fdfefb","accent":"#27805b","text":"#242824"},"pair":"night"},
  {"id":"comic-panel","name":"分镜稿","description":"漫画网点与黑色分栏","category":"paper","mode":"light","preview":{"page":"#f6f5f1","sidebar":"#e9e7e1","surface":"#fefdf9","accent":"#35383a","text":"#17191a"},"pair":"slate"},
  {"id":"music-sheet","name":"五线谱","description":"谱纸白与乐谱蓝黑","category":"paper","mode":"light","preview":{"page":"#faf9f3","sidebar":"#eeece3","surface":"#fffefa","accent":"#38516e","text":"#24272a"},"pair":"slate"},
  {"id":"field-journal","name":"田野手账","description":"植物标本与橄榄绿墨","category":"paper","mode":"light","preview":{"page":"#f6f3e8","sidebar":"#e9e4d6","surface":"#fdfaf0","accent":"#667044","text":"#2e3022"},"pair":"graphite"},
  {"id":"blackboard","name":"课堂黑板","description":"粉笔线与墨绿黑板","category":"paper","mode":"dark","preview":{"page":"#14201c","sidebar":"#1d2c26","surface":"#273831","accent":"#e4c96b","text":"#f3f4e8"},"pair":"amber"},
  {"id":"dark-notebook","name":"夜间笔记","description":"深灰纸与荧光批注","category":"paper","mode":"dark","preview":{"page":"#17191d","sidebar":"#20242a","surface":"#292e35","accent":"#6fc3ff","text":"#f1f5fa"},"pair":"snow"},
  {"id":"film-cream","name":"胶片奶油","description":"暖白相纸与胶片棕","category":"retro","mode":"light","preview":{"page":"#f6f0e4","sidebar":"#e9dfcf","surface":"#fdf8ee","accent":"#9a4f36","text":"#30261e"},"pair":"graphite"},
  {"id":"vinyl-jazz","name":"黑胶爵士","description":"唱片黑与舞台铜金","category":"retro","mode":"dark","preview":{"page":"#171513","sidebar":"#221f1b","surface":"#2c2823","accent":"#d49b47","text":"#fff5e5"},"pair":"amber"},
  {"id":"newsprint","name":"晨报","description":"新闻纸灰与油墨蓝","category":"retro","mode":"light","preview":{"page":"#f1efe8","sidebar":"#e3e0d6","surface":"#faf8f1","accent":"#3f6178","text":"#242321"},"pair":"slate"},
  {"id":"typewriter","name":"打字机","description":"旧纸、机械灰与红色键帽","category":"retro","mode":"light","preview":{"page":"#f5f0e6","sidebar":"#e7e0d3","surface":"#fcf8ef","accent":"#a44338","text":"#2d2924"},"pair":"graphite"},
  {"id":"radio-dial","name":"收音刻度","description":"收音机绿与琥珀指针","category":"retro","mode":"dark","preview":{"page":"#161b18","sidebar":"#202722","surface":"#2a322c","accent":"#e0a13b","text":"#f1f5ed"},"pair":"amber"},
  {"id":"seventies","name":"七十年代","description":"芥末黄、砖红与橄榄绿","category":"retro","mode":"light","preview":{"page":"#f4ecd8","sidebar":"#e5dac1","surface":"#fbf5e6","accent":"#a94f34","text":"#33291c"},"pair":"graphite"},
  {"id":"cassette","name":"磁带侧录","description":"磁带灰与橘红标签","category":"retro","mode":"dark","preview":{"page":"#1b1b1a","sidebar":"#262624","surface":"#30302d","accent":"#f07945","text":"#f5f1e9"},"pair":"amber"},
  {"id":"mint-terminal","name":"薄荷终端","description":"老式显示器的柔和绿光","category":"retro","mode":"dark","preview":{"page":"#111814","sidebar":"#18221d","surface":"#202d26","accent":"#66c18a","text":"#e9fff1"},"pair":"jade"},
  {"id":"postcard","name":"旅行明信片","description":"褪色海蓝与邮戳红","category":"retro","mode":"light","preview":{"page":"#f5efe4","sidebar":"#e8dfd1","surface":"#fdf8ee","accent":"#39788a","text":"#302a24"},"pair":"slate"},
  {"id":"apricot-kitchen","name":"杏色厨房","description":"瓷砖格与珐琅杏色","category":"retro","mode":"light","preview":{"page":"#fff2e2","sidebar":"#f1e3d2","surface":"#fffaf3","accent":"#c7613f","text":"#3b2a20"},"pair":"graphite"},
  {"id":"library-card","name":"借书卡","description":"卡片米白与馆藏墨绿","category":"retro","mode":"light","preview":{"page":"#f5f0e4","sidebar":"#e6dece","surface":"#fcf8ee","accent":"#46634e","text":"#292820"},"pair":"slate"},
  {"id":"darkroom","name":"暗房","description":"暗房红灯与深褐黑","category":"retro","mode":"dark","preview":{"page":"#1b1212","sidebar":"#281a19","surface":"#342220","accent":"#d65345","text":"#fff0ec"},"pair":"amber"},
  {"id":"quantum-blue","name":"量子蓝","description":"高对比蓝光与精密网格","category":"future","mode":"dark","preview":{"page":"#071423","sidebar":"#0d2034","surface":"#132b43","accent":"#43a4ff","text":"#eef8ff"},"pair":"snow"},
  {"id":"neon-mint","name":"霓虹薄荷","description":"深黑底与薄荷荧光","category":"future","mode":"dark","preview":{"page":"#071714","sidebar":"#0d2420","surface":"#14322c","accent":"#3de0ad","text":"#ebfff8"},"pair":"jade"},
  {"id":"orbital","name":"轨道站","description":"轨道线与警示橙","category":"future","mode":"dark","preview":{"page":"#11151c","sidebar":"#1a2029","surface":"#232c38","accent":"#ff8b4a","text":"#f4f7fb"},"pair":"amber"},
  {"id":"magenta-core","name":"洋红核心","description":"黑紫空间与洋红信号","category":"future","mode":"dark","preview":{"page":"#170d1c","sidebar":"#241329","surface":"#301b37","accent":"#f45bb3","text":"#fff1fb"},"pair":"amber"},
  {"id":"cyber-lime","name":"赛博青柠","description":"深蓝黑与青柠标记","category":"future","mode":"dark","preview":{"page":"#0c1118","sidebar":"#141d27","surface":"#1c2834","accent":"#b8e548","text":"#f7ffe8"},"pair":"amber"},
  {"id":"holo-ice","name":"全息冰","description":"冷白界面与虹彩蓝紫","category":"future","mode":"light","preview":{"page":"#f1f7fb","sidebar":"#e2edf4","surface":"#fbfeff","accent":"#5d66d6","text":"#17263a"},"pair":"slate"},
  {"id":"solar-array","name":"太阳阵列","description":"深空蓝与能量金","category":"future","mode":"dark","preview":{"page":"#0b1420","sidebar":"#121f2e","surface":"#1a2a3a","accent":"#e7b94d","text":"#fff9e8"},"pair":"amber"},
  {"id":"signal-red","name":"红色信标","description":"舰桥深灰与紧急红","category":"future","mode":"dark","preview":{"page":"#151719","sidebar":"#202326","surface":"#292e32","accent":"#ee5a4f","text":"#fff4f2"},"pair":"amber"},
  {"id":"bio-lab","name":"生物舱","description":"实验白与培养液青绿","category":"future","mode":"light","preview":{"page":"#eff8f6","sidebar":"#deeeea","surface":"#fbfffe","accent":"#168873","text":"#14302b"},"pair":"night"},
  {"id":"violet-terminal","name":"紫晶终端","description":"暗紫终端与冷白字符","category":"future","mode":"dark","preview":{"page":"#130f20","sidebar":"#1d172c","surface":"#282037","accent":"#9a78ff","text":"#f7f2ff"},"pair":"snow"},
  {"id":"deep-scan","name":"深海扫描","description":"声呐线与深海青","category":"future","mode":"dark","preview":{"page":"#07181d","sidebar":"#0e252b","surface":"#16333a","accent":"#3bc0c6","text":"#eaffff"},"pair":"jade"},
  {"id":"white-module","name":"白色模组","description":"模块化冷白与信号蓝","category":"future","mode":"light","preview":{"page":"#f3f6f8","sidebar":"#e5eaee","surface":"#ffffff","accent":"#376fae","text":"#18232d"},"pair":"slate"},
  {"id":"spring-rain","name":"春雨","description":"嫩叶、细雨与湿润灰白","category":"seasonal","mode":"light","preview":{"page":"#f2f7f1","sidebar":"#e2ede1","surface":"#fcfffb","accent":"#3f845c","text":"#1d2c21"},"pair":"night"},
  {"id":"peach-blossom","name":"花朝","description":"桃花粉与春日新绿","category":"seasonal","mode":"light","preview":{"page":"#fff4f5","sidebar":"#f4e7e8","surface":"#fffdfc","accent":"#c94d68","text":"#352126"},"pair":"graphite"},
  {"id":"grain-rain","name":"谷雨","description":"谷物黄与雨后青","category":"seasonal","mode":"light","preview":{"page":"#f7f5e8","sidebar":"#ebe7d3","surface":"#fffdf3","accent":"#688144","text":"#2b301f"},"pair":"graphite"},
  {"id":"early-summer","name":"初夏","description":"荷叶绿与清亮水色","category":"seasonal","mode":"light","preview":{"page":"#eff8f3","sidebar":"#deede5","surface":"#fbfffd","accent":"#278266","text":"#153029"},"pair":"night"},
  {"id":"midsummer","name":"盛夏","description":"日光黄与浓荫绿","category":"seasonal","mode":"light","preview":{"page":"#fff9e7","sidebar":"#f1ebce","surface":"#fffef5","accent":"#417b45","text":"#292c19"},"pair":"night"},
  {"id":"lotus-night","name":"荷塘夜","description":"荷叶暗绿与月光粉","category":"seasonal","mode":"dark","preview":{"page":"#0e1c19","sidebar":"#162925","surface":"#203630","accent":"#e68ca8","text":"#f7fffc"},"pair":"amber"},
  {"id":"white-dew","name":"白露","description":"露水蓝与芦苇灰","category":"seasonal","mode":"light","preview":{"page":"#f2f7f8","sidebar":"#e4edef","surface":"#fcfeff","accent":"#4d7f91","text":"#213037"},"pair":"slate"},
  {"id":"maple-frost","name":"霜枫","description":"枫叶红与霜白","category":"seasonal","mode":"light","preview":{"page":"#f8f2ee","sidebar":"#eee3dd","surface":"#fffaf7","accent":"#a94735","text":"#33231d"},"pair":"graphite"},
  {"id":"golden-field","name":"秋收","description":"麦穗金与土壤褐","category":"seasonal","mode":"light","preview":{"page":"#f8f3e4","sidebar":"#ece3cd","surface":"#fffaf0","accent":"#a66d24","text":"#352a1c"},"pair":"graphite"},
  {"id":"first-snow","name":"初雪","description":"雪蓝、雾灰与一点松绿","category":"seasonal","mode":"light","preview":{"page":"#f3f7f9","sidebar":"#e4ebef","surface":"#fdfeff","accent":"#397269","text":"#1d2c2d"},"pair":"night"},
  {"id":"winter-solstice","name":"冬至","description":"深靛夜与温暖灯橙","category":"seasonal","mode":"dark","preview":{"page":"#111827","sidebar":"#192338","surface":"#232f46","accent":"#e59a46","text":"#fff7e9"},"pair":"amber"},
  {"id":"new-year-paper","name":"岁朝","description":"朱红、宣纸与细金线","category":"seasonal","mode":"light","preview":{"page":"#fbf3ea","sidebar":"#efe4d8","surface":"#fffaf2","accent":"#a93232","text":"#33251f"},"pair":"graphite"},
  {"id":"starry","name":"星空","description":"午夜蓝与微光星点","category":"night","mode":"dark","preview":{"page":"#0c1220","sidebar":"#111a2b","surface":"#172237","accent":"#71a7ff","text":"#f3f7ff"},"pair":"snow"},
  {"id":"obsidian","name":"黑曜","description":"近黑表面与冷银文字","category":"night","mode":"dark","preview":{"page":"#101112","sidebar":"#181a1d","surface":"#202328","accent":"#8ca5bd","text":"#f5f7fa"},"pair":"snow"},
  {"id":"midnight-rose","name":"夜玫瑰","description":"酒红暗面与柔粉高光","category":"night","mode":"dark","preview":{"page":"#1b1015","sidebar":"#27171e","surface":"#321f27","accent":"#e06d98","text":"#fff1f6"},"pair":"amber"},
  {"id":"deep-forest","name":"深林","description":"深绿阴影与萤火黄绿","category":"night","mode":"dark","preview":{"page":"#0d1712","sidebar":"#15231b","surface":"#1e3025","accent":"#8ecb62","text":"#f2ffec"},"pair":"jade"},
  {"id":"indigo-rain","name":"靛雨","description":"靛蓝夜与连续雨丝","category":"night","mode":"dark","preview":{"page":"#101426","sidebar":"#181d34","surface":"#222842","accent":"#758cff","text":"#f1f4ff"},"pair":"snow"},
  {"id":"ember-room","name":"余烬","description":"炭黑空间与余烬橙","category":"night","mode":"dark","preview":{"page":"#171311","sidebar":"#221c19","surface":"#2d2521","accent":"#ef7944","text":"#fff2ea"},"pair":"amber"},
  {"id":"violet-dusk","name":"紫暮","description":"暮紫与遥远蓝光","category":"night","mode":"dark","preview":{"page":"#151222","sidebar":"#201a30","surface":"#2a243c","accent":"#9d7be8","text":"#f8f3ff"},"pair":"snow"},
  {"id":"navy-office","name":"深海办公室","description":"低干扰藏蓝工作界面","category":"night","mode":"dark","preview":{"page":"#0d1721","sidebar":"#152230","surface":"#1e2e3d","accent":"#4fa7c8","text":"#eef9ff"},"pair":"snow"},
  {"id":"red-moon","name":"赤月","description":"暗红月影与石墨黑","category":"night","mode":"dark","preview":{"page":"#1a1113","sidebar":"#26191c","surface":"#322226","accent":"#d85b56","text":"#fff0ee"},"pair":"amber"},
  {"id":"polar-night","name":"极夜","description":"极夜蓝与冰青光点","category":"night","mode":"dark","preview":{"page":"#07141d","sidebar":"#0d202b","surface":"#142d39","accent":"#51c8d3","text":"#ecfdff"},"pair":"jade"},
  {"id":"coffee-code","name":"咖啡代码","description":"深咖啡与拿铁金标记","category":"night","mode":"dark","preview":{"page":"#18130f","sidebar":"#241c17","surface":"#30251f","accent":"#d0a25f","text":"#fff6e9"},"pair":"amber"},
  {"id":"quiet-terminal","name":"静默终端","description":"低对比墨绿与终端青","category":"night","mode":"dark","preview":{"page":"#0d1513","sidebar":"#14201d","surface":"#1c2b27","accent":"#58b99b","text":"#eefbf7"},"pair":"jade"},
] as const satisfies readonly ThemeDefinition[];
export type ThemeId = (typeof themeCatalog)[number]["id"];

/** 仅迁移已不在目录中的历史标识，恢复的原主题直接保留。 */
export const LEGACY_THEMES: Record<string, ThemeId> = {
  "paper": "jade",
  "mist": "snow",
  "grove": "jade",
  "sunrise": "amber",
  "midnight": "slate",
  "aurora": "night"
};
