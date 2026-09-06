export type ThemeMode = 'light' | 'dark';

export type ThemePattern =
  | 'plain'
  | 'stars'
  | 'grid'
  | 'diagonal'
  | 'dots'
  | 'paper'
  | 'sketch'
  | 'waves'
  | 'rain'
  | 'circuit'
  | 'confetti'
  | 'petals'
  | 'topography'
  | 'plaid'
  | 'halftone'
  | 'sunbeams';

export type ThemeCategoryId =
  | 'classic'
  | 'nature'
  | 'storybook'
  | 'playful'
  | 'paper'
  | 'retro'
  | 'future'
  | 'seasonal'
  | 'night';

export type ThemeDefinition = {
  id: string;
  name: string;
  description: string;
  mode: ThemeMode;
  category: ThemeCategoryId;
  pattern: ThemePattern;
  featured: boolean;
  preview: {
    page: string;
    sidebar: string;
    surface: string;
    accent: string;
    text: string;
  };
};

export const themeCategories = [
  { id: 'classic', name: '基础', description: '安静、耐看的日常工作界面' },
  { id: 'nature', name: '自然', description: '森林、海岸、旷野与植物色彩' },
  { id: 'storybook', name: '手绘幻想', description: '原创绘本气质与轻叙事场景' },
  { id: 'playful', name: '萌趣', description: '轻快糖果色与电气伙伴想象' },
  { id: 'paper', name: '纸张线稿', description: '方格、稿纸、铅笔与编辑部质感' },
  { id: 'retro', name: '复古', description: '胶片、唱片、报刊与旧式设备' },
  { id: 'future', name: '未来', description: '终端、霓虹、轨道与数字界面' },
  { id: 'seasonal', name: '节气', description: '四季、天气与东方时令配色' },
  { id: 'night', name: '深夜', description: '适合低照度环境的沉浸暗色' },
] as const satisfies readonly { id: ThemeCategoryId; name: string; description: string }[];

type Palette = readonly [page: string, sidebar: string, surface: string, accent: string, text: string];

function theme<Id extends string>(
  id: Id,
  name: string,
  description: string,
  category: ThemeCategoryId,
  mode: ThemeMode,
  pattern: ThemePattern,
  palette: Palette,
  featured = false,
): ThemeDefinition & { id: Id } {
  const [page, sidebar, surface, accent, text] = palette;
  return {
    id,
    name,
    description,
    category,
    mode,
    pattern,
    featured,
    preview: { page, sidebar, surface, accent, text },
  };
}

/**
 * 主题全部使用原创命名与配色，不包含第三方角色、商标或受版权保护的画面。
 * 每个分类固定 12 套，便于后续按整组增删和做用户偏好分析。
 */
export const themeCatalog = [
  // 基础 12
  theme('jade', '浅玉', '纸白与松石绿', 'classic', 'light', 'plain', ['#f4f5f1', '#ecefe9', '#ffffff', '#14775f', '#17191d'], true),
  theme('night', '夜墨', '安静的深色界面', 'classic', 'dark', 'plain', ['#181c1a', '#202522', '#252a27', '#32a982', '#f2f5f3'], true),
  theme('rose', '玫瑰', '克制的玫红与雾粉', 'classic', 'light', 'diagonal', ['#fbf4f6', '#f5e9ed', '#fffafb', '#b13c62', '#291a20'], true),
  theme('grid', '线格', '清晰的蓝灰工作台', 'classic', 'light', 'grid', ['#f4f7fa', '#e9eef3', '#ffffff', '#356a96', '#17212b'], true),
  theme('ocean', '海雾', '海蓝与冷调白', 'classic', 'light', 'plain', ['#f1f7f8', '#e4eff1', '#fbfefe', '#16758a', '#13272c']),
  theme('forest', '青森', '杉木绿与薄荷灰', 'classic', 'light', 'dots', ['#f2f6f3', '#e5ede8', '#fbfdfb', '#356b4d', '#18251e']),
  theme('amber', '琥珀', '暖金色的明亮强调', 'classic', 'light', 'plain', ['#f7f6f2', '#efede6', '#fffefd', '#a96012', '#28231d']),
  theme('ink', '墨韵', '黑白灰的专注阅读', 'classic', 'light', 'paper', ['#f3f3f2', '#e8e8e6', '#fdfdfc', '#343a3c', '#151718'], true),
  theme('blueprint', '蓝图', '深蓝线格与青色标记', 'classic', 'dark', 'grid', ['#0b1a24', '#102532', '#163241', '#45b8c7', '#edf9fb']),
  theme('sky', '晴空', '明快的天蓝与云白', 'classic', 'light', 'dots', ['#f3f7fc', '#e7eef7', '#ffffff', '#3778c2', '#172235']),
  theme('iris', '鸢尾', '低饱和紫与冷灰', 'classic', 'light', 'diagonal', ['#f6f4f8', '#ece8f1', '#fefcff', '#735a91', '#241d2c']),
  theme('graphite', '石墨', '深灰界面与橙色标记', 'classic', 'dark', 'plain', ['#161819', '#202326', '#282c2f', '#e17632', '#f4f3f1']),

  // 自然 12
  theme('moss-path', '苔径', '雨后石阶与湿润苔色', 'nature', 'light', 'topography', ['#f1f4ed', '#e3eadf', '#fbfcf8', '#55734d', '#1d291b'], true),
  theme('pine-wind', '松风', '冷杉、山风与清晨薄雾', 'nature', 'light', 'waves', ['#eef4f1', '#dfe9e4', '#fafdfb', '#2f6f5c', '#162820']),
  theme('reed-bank', '芦岸', '河岸灰绿与亚麻白', 'nature', 'light', 'diagonal', ['#f5f4ed', '#eae8dc', '#fffef8', '#6a7650', '#292b20']),
  theme('coral-tide', '珊瑚潮', '浅海青与珊瑚红', 'nature', 'light', 'waves', ['#f1f8f7', '#e0eeeb', '#fbfffe', '#d45c55', '#17302f'], true),
  theme('glacier', '冰川', '冰蓝裂隙与雪原白', 'nature', 'light', 'grid', ['#f1f7fa', '#e2eef4', '#fcfeff', '#2c86a8', '#132b37']),
  theme('canyon', '峡谷', '岩层红与风化砂岩', 'nature', 'light', 'topography', ['#f8f2ed', '#eee2d8', '#fffaf6', '#a64d36', '#352018']),
  theme('bamboo-rain', '竹雨', '新竹绿与细密雨线', 'nature', 'light', 'rain', ['#f2f7f2', '#e3eee4', '#fcfffc', '#2f7d54', '#17291e']),
  theme('lavender-field', '薰衣草田', '灰紫花田与晨光', 'nature', 'light', 'petals', ['#f7f4f9', '#ece7f1', '#fffaff', '#8064a2', '#2b2332']),
  theme('desert-bloom', '沙漠花', '矿物粉与仙人掌绿', 'nature', 'light', 'dots', ['#f8f3ec', '#eee5da', '#fffaf3', '#3f8067', '#33261d']),
  theme('aurora-lake', '极光湖', '冷夜湖面与极光绿', 'nature', 'dark', 'waves', ['#09191c', '#10262a', '#163338', '#55d6a7', '#ecfffa'], true),
  theme('volcanic-ash', '火山灰', '黑岩、余烬与低饱和红', 'nature', 'dark', 'halftone', ['#181616', '#231f1e', '#2c2725', '#e36f4a', '#fff2ed']),
  theme('peach-orchard', '桃园', '桃花粉与枝叶青', 'nature', 'light', 'petals', ['#fff5f4', '#f5e9e6', '#fffdfb', '#c65068', '#352126']),

  // 手绘幻想 12
  theme('wind-meadow', '风之原野', '风车、草坡与大片留白', 'storybook', 'light', 'sketch', ['#f5f7ed', '#e7eddf', '#fffef8', '#4d8b68', '#243024'], true),
  theme('cloud-post', '云上邮局', '云朵、邮戳与天青纸张', 'storybook', 'light', 'paper', ['#f3f8fb', '#e4eff5', '#ffffff', '#3f7faa', '#20303b'], true),
  theme('forest-station', '森林车站', '木牌、小站与深林绿', 'storybook', 'light', 'sketch', ['#f2f5ed', '#e2e9dd', '#fbfdf8', '#4d7451', '#20291e']),
  theme('flying-workshop', '飞行工坊', '黄铜零件与手绘蓝图', 'storybook', 'light', 'grid', ['#f7f3e9', '#ebe4d4', '#fffdf6', '#8b5b24', '#30271d']),
  theme('lamp-house', '雨夜灯屋', '窗灯、雨线与深青夜色', 'storybook', 'dark', 'rain', ['#0f1c20', '#17292e', '#20363b', '#f0b84d', '#f6fbfa'], true),
  theme('moon-library', '月光图书馆', '书页、月影与静谧蓝紫', 'storybook', 'dark', 'stars', ['#121526', '#1b2034', '#242b42', '#a9a0ff', '#f5f3ff']),
  theme('little-planet', '小小星球', '轨道线与温柔宇宙色', 'storybook', 'light', 'stars', ['#f5f4fb', '#e9e7f3', '#fefcff', '#6f64bd', '#26223b']),
  theme('tea-clock', '茶时钟', '红茶、钟面与旧纸张', 'storybook', 'light', 'paper', ['#f8f3e8', '#eee5d5', '#fffaf0', '#9b5a31', '#35281d']),
  theme('whale-letter', '鲸鱼来信', '海面邮简与鲸蓝', 'storybook', 'light', 'waves', ['#eff7f9', '#dfedf1', '#fbfeff', '#25758f', '#18313a']),
  theme('seed-airship', '种子飞船', '植物舱与轻盈机械线稿', 'storybook', 'light', 'circuit', ['#f3f7ef', '#e5eddf', '#fcfff9', '#557d3e', '#263120']),
  theme('snow-cabin', '雪原木屋', '雪白、木色与炉火橙', 'storybook', 'light', 'dots', ['#f4f7f8', '#e7edef', '#ffffff', '#b85f32', '#2d2824']),
  theme('midnight-carousel', '午夜旋转台', '深紫夜幕与金色灯点', 'storybook', 'dark', 'confetti', ['#171225', '#211a31', '#2b233d', '#e2b85c', '#fff8e8']),

  // 萌趣 12
  theme('lemon-spark', '柠檬电波', '柠檬黄与清爽电光蓝', 'playful', 'light', 'circuit', ['#fffbea', '#f5f0cf', '#fffef7', '#e0a800', '#2f2a16'], true),
  theme('spark-buddy', '闪电团子', '圆润图形与活力电气感', 'playful', 'light', 'confetti', ['#fff8db', '#f4eebd', '#fffdf2', '#376dd6', '#282615'], true),
  theme('mint-soda', '薄荷汽水', '气泡点与薄荷青', 'playful', 'light', 'dots', ['#effbf8', '#dcf1ec', '#fbfffe', '#168b75', '#15312b']),
  theme('berry-milk', '莓果牛奶', '莓红、奶白与柔软圆点', 'playful', 'light', 'dots', ['#fff3f6', '#f8e3e9', '#fffafd', '#c33d68', '#3a2029']),
  theme('orange-catnap', '橘色午睡', '暖橙、奶油与慵懒线条', 'playful', 'light', 'sketch', ['#fff6e9', '#f5ead7', '#fffdf8', '#d66b28', '#3b281a']),
  theme('grape-jelly', '葡萄果冻', '透明紫与弹跳几何', 'playful', 'light', 'confetti', ['#f8f2ff', '#eee3f7', '#fffaff', '#8755bd', '#2e203b']),
  theme('blue-bubble', '蓝莓气泡', '蓝紫气泡与清亮白', 'playful', 'light', 'dots', ['#f1f5ff', '#e2e9f8', '#fbfdff', '#4b6fc8', '#1d2944']),
  theme('melon-day', '蜜瓜日', '蜜瓜绿与果肉橙', 'playful', 'light', 'plaid', ['#f5faea', '#e7f0d4', '#fffef6', '#e0713c', '#29301c']),
  theme('candy-check', '糖纸格', '彩色方格与糖纸反光感', 'playful', 'light', 'plaid', ['#fff6f2', '#f4e7e2', '#fffdfb', '#d14f64', '#382428']),
  theme('pixel-pet', '像素伙伴', '像素网格与荧光绿色', 'playful', 'dark', 'grid', ['#101914', '#18241d', '#213028', '#72dd83', '#effff1']),
  theme('arcade-pop', '街机波普', '深靛底上的桃红与青', 'playful', 'dark', 'halftone', ['#171426', '#211c34', '#2c2542', '#ff618e', '#fff4fa']),
  theme('rainbow-pencil', '彩铅盒', '多彩标记与素描纸', 'playful', 'light', 'sketch', ['#f8f7f2', '#eceae1', '#fffefa', '#4e79bd', '#292823']),

  // 纸张线稿 12
  theme('notebook-blue', '蓝线笔记', '横线纸与蓝墨水', 'paper', 'light', 'paper', ['#f8faf8', '#edf1ef', '#ffffff', '#376fa6', '#20272d'], true),
  theme('architect', '建筑方格', '毫米方格与工程红标', 'paper', 'light', 'grid', ['#f5f7f5', '#e8ece9', '#fdfefd', '#b94c3d', '#202522']),
  theme('pencil-margin', '铅笔页边', '石墨线与留白稿纸', 'paper', 'light', 'sketch', ['#f7f6f1', '#ebe9e1', '#fffef9', '#4e5960', '#252725'], true),
  theme('editorial-red', '编辑红笔', '校样纸与编辑批注红', 'paper', 'light', 'diagonal', ['#faf8f3', '#efebe2', '#fffefa', '#ba3e38', '#2c2925']),
  theme('legal-pad', '黄页便笺', '淡黄纸与深蓝墨迹', 'paper', 'light', 'paper', ['#fffbea', '#f2edce', '#fffef4', '#315c8a', '#2b291d']),
  theme('kraft-note', '牛皮纸', '纸纤维与深咖啡墨色', 'paper', 'light', 'paper', ['#f4ead8', '#e6d8c1', '#fbf3e5', '#79522f', '#34281c']),
  theme('receipt-roll', '票据卷', '热敏纸灰与收银绿', 'paper', 'light', 'diagonal', ['#f6f7f4', '#e9ebe6', '#fdfefb', '#27805b', '#242824']),
  theme('comic-panel', '分镜稿', '漫画网点与黑色分栏', 'paper', 'light', 'halftone', ['#f6f5f1', '#e9e7e1', '#fefdf9', '#35383a', '#17191a']),
  theme('music-sheet', '五线谱', '谱纸白与乐谱蓝黑', 'paper', 'light', 'paper', ['#faf9f3', '#eeece3', '#fffefa', '#38516e', '#24272a']),
  theme('field-journal', '田野手账', '植物标本与橄榄绿墨', 'paper', 'light', 'sketch', ['#f6f3e8', '#e9e4d6', '#fdfaf0', '#667044', '#2e3022']),
  theme('blackboard', '课堂黑板', '粉笔线与墨绿黑板', 'paper', 'dark', 'sketch', ['#14201c', '#1d2c26', '#273831', '#e4c96b', '#f3f4e8'], true),
  theme('dark-notebook', '夜间笔记', '深灰纸与荧光批注', 'paper', 'dark', 'paper', ['#17191d', '#20242a', '#292e35', '#6fc3ff', '#f1f5fa']),

  // 复古 12
  theme('film-cream', '胶片奶油', '暖白相纸与胶片棕', 'retro', 'light', 'halftone', ['#f6f0e4', '#e9dfcf', '#fdf8ee', '#9a4f36', '#30261e'], true),
  theme('vinyl-jazz', '黑胶爵士', '唱片黑与舞台铜金', 'retro', 'dark', 'sunbeams', ['#171513', '#221f1b', '#2c2823', '#d49b47', '#fff5e5'], true),
  theme('newsprint', '晨报', '新闻纸灰与油墨蓝', 'retro', 'light', 'paper', ['#f1efe8', '#e3e0d6', '#faf8f1', '#3f6178', '#242321']),
  theme('typewriter', '打字机', '旧纸、机械灰与红色键帽', 'retro', 'light', 'paper', ['#f5f0e6', '#e7e0d3', '#fcf8ef', '#a44338', '#2d2924']),
  theme('radio-dial', '收音刻度', '收音机绿与琥珀指针', 'retro', 'dark', 'grid', ['#161b18', '#202722', '#2a322c', '#e0a13b', '#f1f5ed']),
  theme('seventies', '七十年代', '芥末黄、砖红与橄榄绿', 'retro', 'light', 'sunbeams', ['#f4ecd8', '#e5dac1', '#fbf5e6', '#a94f34', '#33291c']),
  theme('cassette', '磁带侧录', '磁带灰与橘红标签', 'retro', 'dark', 'diagonal', ['#1b1b1a', '#262624', '#30302d', '#f07945', '#f5f1e9']),
  theme('mint-terminal', '薄荷终端', '老式显示器的柔和绿光', 'retro', 'dark', 'grid', ['#111814', '#18221d', '#202d26', '#66c18a', '#e9fff1']),
  theme('postcard', '旅行明信片', '褪色海蓝与邮戳红', 'retro', 'light', 'diagonal', ['#f5efe4', '#e8dfd1', '#fdf8ee', '#39788a', '#302a24']),
  theme('apricot-kitchen', '杏色厨房', '瓷砖格与珐琅杏色', 'retro', 'light', 'plaid', ['#fff2e2', '#f1e3d2', '#fffaf3', '#c7613f', '#3b2a20']),
  theme('library-card', '借书卡', '卡片米白与馆藏墨绿', 'retro', 'light', 'paper', ['#f5f0e4', '#e6dece', '#fcf8ee', '#46634e', '#292820']),
  theme('darkroom', '暗房', '暗房红灯与深褐黑', 'retro', 'dark', 'halftone', ['#1b1212', '#281a19', '#342220', '#d65345', '#fff0ec']),

  // 未来 12
  theme('quantum-blue', '量子蓝', '高对比蓝光与精密网格', 'future', 'dark', 'grid', ['#071423', '#0d2034', '#132b43', '#43a4ff', '#eef8ff'], true),
  theme('neon-mint', '霓虹薄荷', '深黑底与薄荷荧光', 'future', 'dark', 'circuit', ['#071714', '#0d2420', '#14322c', '#3de0ad', '#ebfff8'], true),
  theme('orbital', '轨道站', '轨道线与警示橙', 'future', 'dark', 'topography', ['#11151c', '#1a2029', '#232c38', '#ff8b4a', '#f4f7fb']),
  theme('magenta-core', '洋红核心', '黑紫空间与洋红信号', 'future', 'dark', 'circuit', ['#170d1c', '#241329', '#301b37', '#f45bb3', '#fff1fb']),
  theme('cyber-lime', '赛博青柠', '深蓝黑与青柠标记', 'future', 'dark', 'halftone', ['#0c1118', '#141d27', '#1c2834', '#b8e548', '#f7ffe8']),
  theme('holo-ice', '全息冰', '冷白界面与虹彩蓝紫', 'future', 'light', 'diagonal', ['#f1f7fb', '#e2edf4', '#fbfeff', '#5d66d6', '#17263a']),
  theme('solar-array', '太阳阵列', '深空蓝与能量金', 'future', 'dark', 'grid', ['#0b1420', '#121f2e', '#1a2a3a', '#e7b94d', '#fff9e8']),
  theme('signal-red', '红色信标', '舰桥深灰与紧急红', 'future', 'dark', 'circuit', ['#151719', '#202326', '#292e32', '#ee5a4f', '#fff4f2']),
  theme('bio-lab', '生物舱', '实验白与培养液青绿', 'future', 'light', 'dots', ['#eff8f6', '#deeeea', '#fbfffe', '#168873', '#14302b']),
  theme('violet-terminal', '紫晶终端', '暗紫终端与冷白字符', 'future', 'dark', 'grid', ['#130f20', '#1d172c', '#282037', '#9a78ff', '#f7f2ff']),
  theme('deep-scan', '深海扫描', '声呐线与深海青', 'future', 'dark', 'waves', ['#07181d', '#0e252b', '#16333a', '#3bc0c6', '#eaffff']),
  theme('white-module', '白色模组', '模块化冷白与信号蓝', 'future', 'light', 'circuit', ['#f3f6f8', '#e5eaee', '#ffffff', '#376fae', '#18232d']),

  // 节气 12
  theme('spring-rain', '春雨', '嫩叶、细雨与湿润灰白', 'seasonal', 'light', 'rain', ['#f2f7f1', '#e2ede1', '#fcfffb', '#3f845c', '#1d2c21'], true),
  theme('peach-blossom', '花朝', '桃花粉与春日新绿', 'seasonal', 'light', 'petals', ['#fff4f5', '#f4e7e8', '#fffdfc', '#c94d68', '#352126']),
  theme('grain-rain', '谷雨', '谷物黄与雨后青', 'seasonal', 'light', 'rain', ['#f7f5e8', '#ebe7d3', '#fffdf3', '#688144', '#2b301f']),
  theme('early-summer', '初夏', '荷叶绿与清亮水色', 'seasonal', 'light', 'waves', ['#eff8f3', '#deede5', '#fbfffd', '#278266', '#153029']),
  theme('midsummer', '盛夏', '日光黄与浓荫绿', 'seasonal', 'light', 'sunbeams', ['#fff9e7', '#f1ebce', '#fffef5', '#417b45', '#292c19'], true),
  theme('lotus-night', '荷塘夜', '荷叶暗绿与月光粉', 'seasonal', 'dark', 'waves', ['#0e1c19', '#162925', '#203630', '#e68ca8', '#f7fffc']),
  theme('white-dew', '白露', '露水蓝与芦苇灰', 'seasonal', 'light', 'dots', ['#f2f7f8', '#e4edef', '#fcfeff', '#4d7f91', '#213037']),
  theme('maple-frost', '霜枫', '枫叶红与霜白', 'seasonal', 'light', 'petals', ['#f8f2ee', '#eee3dd', '#fffaf7', '#a94735', '#33231d']),
  theme('golden-field', '秋收', '麦穗金与土壤褐', 'seasonal', 'light', 'diagonal', ['#f8f3e4', '#ece3cd', '#fffaf0', '#a66d24', '#352a1c']),
  theme('first-snow', '初雪', '雪蓝、雾灰与一点松绿', 'seasonal', 'light', 'dots', ['#f3f7f9', '#e4ebef', '#fdfeff', '#397269', '#1d2c2d']),
  theme('winter-solstice', '冬至', '深靛夜与温暖灯橙', 'seasonal', 'dark', 'stars', ['#111827', '#192338', '#232f46', '#e59a46', '#fff7e9'], true),
  theme('new-year-paper', '岁朝', '朱红、宣纸与细金线', 'seasonal', 'light', 'paper', ['#fbf3ea', '#efe4d8', '#fffaf2', '#a93232', '#33251f']),

  // 深夜 12
  theme('starry', '星空', '午夜蓝与微光星点', 'night', 'dark', 'stars', ['#0c1220', '#111a2b', '#172237', '#71a7ff', '#f3f7ff'], true),
  theme('obsidian', '黑曜', '近黑表面与冷银文字', 'night', 'dark', 'plain', ['#101112', '#181a1d', '#202328', '#8ca5bd', '#f5f7fa']),
  theme('midnight-rose', '夜玫瑰', '酒红暗面与柔粉高光', 'night', 'dark', 'petals', ['#1b1015', '#27171e', '#321f27', '#e06d98', '#fff1f6'], true),
  theme('deep-forest', '深林', '深绿阴影与萤火黄绿', 'night', 'dark', 'dots', ['#0d1712', '#15231b', '#1e3025', '#8ecb62', '#f2ffec']),
  theme('indigo-rain', '靛雨', '靛蓝夜与连续雨丝', 'night', 'dark', 'rain', ['#101426', '#181d34', '#222842', '#758cff', '#f1f4ff']),
  theme('ember-room', '余烬', '炭黑空间与余烬橙', 'night', 'dark', 'halftone', ['#171311', '#221c19', '#2d2521', '#ef7944', '#fff2ea']),
  theme('violet-dusk', '紫暮', '暮紫与遥远蓝光', 'night', 'dark', 'diagonal', ['#151222', '#201a30', '#2a243c', '#9d7be8', '#f8f3ff']),
  theme('navy-office', '深海办公室', '低干扰藏蓝工作界面', 'night', 'dark', 'plain', ['#0d1721', '#152230', '#1e2e3d', '#4fa7c8', '#eef9ff']),
  theme('red-moon', '赤月', '暗红月影与石墨黑', 'night', 'dark', 'sunbeams', ['#1a1113', '#26191c', '#322226', '#d85b56', '#fff0ee']),
  theme('polar-night', '极夜', '极夜蓝与冰青光点', 'night', 'dark', 'stars', ['#07141d', '#0d202b', '#142d39', '#51c8d3', '#ecfdff']),
  theme('coffee-code', '咖啡代码', '深咖啡与拿铁金标记', 'night', 'dark', 'grid', ['#18130f', '#241c17', '#30251f', '#d0a25f', '#fff6e9']),
  theme('quiet-terminal', '静默终端', '低对比墨绿与终端青', 'night', 'dark', 'circuit', ['#0d1513', '#14201d', '#1c2b27', '#58b99b', '#eefbf7']),
] as const;

export type ThemeId = typeof themeCatalog[number]['id'];
