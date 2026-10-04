/*
 * Spot-Lyric core — JavaScript port of spot-lyric (src/match.c, src/model.c,
 * src/providers.c, src/http.c, src/engine.c).  Pure logic: no DOM access.
 * Network, storage and Spotify access are injected so the same engine runs
 * inside the Spotify renderer and under the Node test-suite.
 *
 * Matching follows the approach of mature lyric tools (Lyricify Lyrics Helper,
 * LDDC, lyrics-plus): Traditional/Simplified folding, version-tag aware titles,
 * multi-artist / CV-alias aware artists, graded duration, missing fields
 * re-weighted, and a widening query cascade.
 */
(function (root) {
  'use strict';

  const DURATION_TOLERANCE = 3000;
  /* Bumped when the stored lyrics format changes (v3: translation merge skips blank lines). */
  const LYRICS_CACHE = 'lyrics4', TRACK_CACHE = 'tracklyrics4:', NEGATIVE = 'negative2:';
  const MAX_RESPONSE = 2 * 1024 * 1024;
  const PROVIDERS = ['netease', 'qq'];
  const PROVIDER_NAMES = { netease: '网易云音乐', qq: 'QQ 音乐', spotify: 'Spotify', local: '本地文件' };

  /* ------------------------------------------------------------ text ---- */
  /* Traditional -> Simplified for the common (GB2312 level-1) characters, from
   * OpenCC's TSCharacters: Spotify often ships Taiwanese / HK metadata
   * (「周杰倫」「說好的幸福呢」) while NetEase / QQ use simplified Chinese. */
  const T2S_FROM = "丟並乾亂亞佈佔併來侖侶侷係俠俬倆倉個們倖倫偉側偵偽傑傘備傢傭傳債傷傾僅僑僕僞僥僱價儀儁億儈儉儘償優儲兇兌兒內兩冊冪凈凍凜凱別刪則剋剎剛剝剮創剷劃劄劇劉劊劍劑勁動務勛勝勞勢勳勵勸勻匯區協卹卻卽厠厤厭厲參叄叢吳吶呂員唸問啓啞啟喚喪喫喬單喲嗆嗎嗚嘆嘔嘗嘩嘯噁噓噴噸噹嚇嚐嚙嚥嚨嚮嚴囂囌囑囪國圍園圓圖團垻埰執堅堯報場塊塗塢塵塹墊墜墮墰墳墻墾壇壓壘壜壞壟壩壯壺壽夠夢夥夾奧奪奬奮妝姦娛婁婦媽嬌嬰嬸孃孫學孿宮寀寢實寧審寫寬寵寶將專尋對導屆屍屜屢層屬岡峯島峽崑崗崙嵗嶄嶺嶼嶽巋巒巖帥師帳帶幀幟幣幫幷幹幾庫廁廂廄廈廕廚廟廠廢廣廬廳弔張強彆彈彌彎彔彙彥彫彿後徑從復徵徹恆恥悅悶悽惡惱愛慄態慘慚慣慫慮慶慼慾憂憊憐憑憚憤憫憲憶懇應懞懲懶懷懸懼懾戀戰戲戶扞拋拚挾捨捱捲掃掄掙掛採揀揚換揮損搖搗搧搶摟摯摳摺摻撈撐撓撣撥撫撲撻撾撿擁擄擇擊擋擔據擠擡擣擬擯擰擱擲擴擺擻擾攆攏攔攙攜攝攢攣攤攪攬敎敗敘敵數斂斃斬斷於旂旣昇時晉晝暈暢暫曆曉曏曠曬書會朮東枴柵柺査桿條棄棊棗棟棧棲楊楓業極榘榦榮構槍槓槳樁樂樑樓標樞樣樸樹橋機橢橫檔檢檯檸檻櫃櫥櫻欄權欽歎歐歡歲歷歸殘殭殲殺殻殼毀毆氈氣氫氾汎汙決沒沖況泝洩洶涼淒淚淨淩淪淵淺渙減渦測渾湊湧湯準溝溫溼滄滅滌滙滬滯滲滷滾滿漁漚漢漣漬漲漸漿潑潔潛潤潰澀澆澇澗澤澱濁濃濕濘濛濟濤濫濰濱濺濾瀉瀋瀕瀝瀰瀾灑灕灘灣灤災為烏烴無煉煙煥煩熒熱熾燈燒燙營燦燬燭燴燻燼爍爐爛爭爲爺爾牀牆牴牽犢犧狀狹狽猙猶獃獄獅獎獨獰獲獵獸獺獻現琱琺瑣瑤瑩瑪環瓊甕產産畝畢畫異畵當疇疊痙痠瘋瘍瘓瘡瘧療癒癟癡癢癥癬癰癱發皁皚皺盃盜盞盡監盤盧盪眞眾睏睜瞞矇矚矯硃硯碩確碼磚礎礙礦礫礬祕祿禍禦禮禱禿稅稈稜種稱穀積穎穢穩穫窩窪窮窯窺竄竅竈竊竪競筆筍箇箋箚節範築篩簍簑簡簽簾籃籌籠籤籬籮籲粵糞糧糰糾紀約紅紉紋納紐純紗紙級紛紡紮細紳紹終絃組絆結絕絛絞絡絢給絨統絲絶絹綁綉綏綑經綜綠綢綫維綱網綳綴綵綸綻綽綿緊緑緒緘線緝緞締緣編緩緬緯練緻縛縣縧縫縮縱縴縷總績繃織繕繞繡繩繪繫繭繳繹繼續纍纏纓纔纖纜缽罈罎罰罵罷羅羣羨義習翫翹聖聞聯聰聲聳聶職聽聾肅脅脈脣脩脫脹腎腦腫腳腸膚膠膩膽膿臉臍臘臟臥臨臺與興舉舊舖舘艙艦艱艷茲荊莊莖莢華菸萊萬葉葦葯葷蒐蒼蓆蓋蓮蔔蔘蔣蔥蔭蕩蕪蕭薊薑薔薦薩薹藍藝藥藴藹蘆蘇蘊蘋蘭蘿處虛虜號虧蛻蝕蝦蝨蝸螞螢蟄蟬蟲蟻蠅蠍蠟蠱蠶蠻衆衊術衕衚衛衝袷裏補裝裡製複褲襖襪襬襯襲覈見規覓視親覺覽觀觸訂訃計訊討訓訖託記訛訝訟訣訪設許訴診註証詐評詛詞詠詢詣試詩詫詭話該詳誅誇誌認誕誘語誠誡誣誤誦誨說説誰課誹誼調諄談請諒論諜諧諮諱諷諸諺諾謀謂謄謅謊謎謗謙講謝謠謡謬謹謾譁證譏識譚譜譟譭譯議譴護譽讀變讒讓讕讚谿豈豎豐豔豬貍貓貝貞負財貢貧貨販貪貫責貯貳貴貶買貸費貼貿賀賂賃賄資賈賊賒賓賜賞賠賢賣賤賦質賬賭賴賺購賽贅贈贊贍贏贓贖贛贜趕趙趨跡踐踰踴蹟蹤躊躍躥軀車軋軌軍軒軟軸較載輓輔輕輛輝輥輩輪輯輸輻輾輿轄轅轉轍轎轟辦辭辮辯農迴逕這連週進遊運過達違遙遜遞遠遡適遲遶遷選遺遼邁還邊邏郵鄉鄒鄖鄧鄭鄰鄲醖醜醞醣醫醬釀釁釋釐釘針釣釦釩釺鈅鈉鈍鈎鈔鈕鈞鈡鈣鈴鈾鉀鉅鉆鉑鉗鉚鉛鉢鉤鉸鉻銀銅銑銘銜銥銳銷銹銻鋁鋅鋇鋒鋤鋪鋭鋸鋼錄錐錘錠錢錦錨錫錯録錳錶鍁鍊鍋鍍鍘鍛鍬鍵鍺鍼鍾鎂鎊鎌鎖鎚鎢鎬鎭鎮鎳鏇鏈鏟鏡鏽鐐鐘鐮鐳鐵鑄鑑鑒鑰鑲鑷鑼鑽鑿長門閃閉開閏閑閒間閘閡閣閤閥閨閩閱閲閹閻闆闇闊闌闖關闡闢陝陞陣陰陳陸陽隊階隕際隨險隱隴隸隻雖雙雛雜雞離難雲電霑霧靈靜鞏鞦韆韋韌韓韻響頁頂頃項順須頌預頑頒頓頗領頤頭頰頸頹頻頽顆題額顏顔願顛類顧顫顯顱顴風颱颳飄飛飢飯飲飼飽飾餃餅養餌餒餓餘餞餡館餬餵餾饅饋饑饒饞馬馭馮馱馳馴駁駐駒駕駛駝駡駭駱駿騁騎騙騰騷騾驅驕驗驚驟驢骯髒體髮鬆鬍鬚鬥鬧鬨鬱魚魯鮑鮮鯉鯨鰓鱉鱗鳥鳳鳴鴉鴕鴛鴦鴨鴻鴿鵑鵝鵬鵰鵲鶴鷄鷗鷹鹵鹹鹼鹽麗麥麪麫麯麴麵麼麽黃點黨黴鼕齊齋齒齡齣齧齲龍龐龔龜";
  const T2S_TO = "丢并干乱亚布占并来仑侣局系侠私俩仓个们幸伦伟侧侦伪杰伞备家佣传债伤倾仅侨仆伪侥雇价仪俊亿侩俭尽偿优储凶兑儿内两册幂净冻凛凯别删则克刹刚剥剐创铲划札剧刘刽剑剂劲动务勋胜劳势勋励劝匀汇区协恤却即厕历厌厉参叁丛吴呐吕员念问启哑启唤丧吃乔单哟呛吗呜叹呕尝哗啸恶嘘喷吨当吓尝啮咽咙向严嚣苏嘱囱国围园圆图团坝采执坚尧报场块涂坞尘堑垫坠堕坛坟墙垦坛压垒坛坏垄坝壮壶寿够梦伙夹奥夺奖奋妆奸娱娄妇妈娇婴婶娘孙学孪宫采寝实宁审写宽宠宝将专寻对导届尸屉屡层属冈峰岛峡昆岗仑岁崭岭屿岳岿峦岩帅师帐带帧帜币帮并干几库厕厢厩厦荫厨庙厂废广庐厅吊张强别弹弥弯录汇彦雕佛后径从复征彻恒耻悦闷凄恶恼爱栗态惨惭惯怂虑庆戚欲忧惫怜凭惮愤悯宪忆恳应蒙惩懒怀悬惧慑恋战戏户捍抛拼挟舍挨卷扫抡挣挂采拣扬换挥损摇捣扇抢搂挚抠折掺捞撑挠掸拨抚扑挞挝捡拥掳择击挡担据挤抬捣拟摈拧搁掷扩摆擞扰撵拢拦搀携摄攒挛摊搅揽教败叙敌数敛毙斩断于旗既升时晋昼晕畅暂历晓向旷晒书会术东拐栅拐查杆条弃棋枣栋栈栖杨枫业极矩干荣构枪杠桨桩乐梁楼标枢样朴树桥机椭横档检台柠槛柜橱樱栏权钦叹欧欢岁历归残僵歼杀壳壳毁殴毡气氢泛泛污决没冲况溯泄汹凉凄泪净凌沦渊浅涣减涡测浑凑涌汤准沟温湿沧灭涤汇沪滞渗卤滚满渔沤汉涟渍涨渐浆泼洁潜润溃涩浇涝涧泽淀浊浓湿泞蒙济涛滥潍滨溅滤泻沈濒沥弥澜洒漓滩湾滦灾为乌烃无炼烟焕烦荧热炽灯烧烫营灿毁烛烩熏烬烁炉烂争为爷尔床墙抵牵犊牺状狭狈狰犹呆狱狮奖独狞获猎兽獭献现雕珐琐瑶莹玛环琼瓮产产亩毕画异画当畴叠痉酸疯疡痪疮疟疗愈瘪痴痒症癣痈瘫发皂皑皱杯盗盏尽监盘卢荡真众困睁瞒蒙瞩矫朱砚硕确码砖础碍矿砾矾秘禄祸御礼祷秃税秆棱种称谷积颖秽稳获窝洼穷窑窥窜窍灶窃竖竞笔笋个笺札节范筑筛篓蓑简签帘篮筹笼签篱箩吁粤粪粮团纠纪约红纫纹纳纽纯纱纸级纷纺扎细绅绍终弦组绊结绝绦绞络绚给绒统丝绝绢绑绣绥捆经综绿绸线维纲网绷缀彩纶绽绰绵紧绿绪缄线缉缎缔缘编缓缅纬练致缚县绦缝缩纵纤缕总绩绷织缮绕绣绳绘系茧缴绎继续累缠缨才纤缆钵坛坛罚骂罢罗群羡义习玩翘圣闻联聪声耸聂职听聋肃胁脉唇修脱胀肾脑肿脚肠肤胶腻胆脓脸脐腊脏卧临台与兴举旧铺馆舱舰艰艳兹荆庄茎荚华烟莱万叶苇药荤搜苍席盖莲卜参蒋葱荫荡芜萧蓟姜蔷荐萨苔蓝艺药蕴蔼芦苏蕴苹兰萝处虚虏号亏蜕蚀虾虱蜗蚂萤蛰蝉虫蚁蝇蝎蜡蛊蚕蛮众蔑术同胡卫冲夹里补装里制复裤袄袜摆衬袭核见规觅视亲觉览观触订讣计讯讨训讫托记讹讶讼诀访设许诉诊注证诈评诅词咏询诣试诗诧诡话该详诛夸志认诞诱语诚诫诬误诵诲说说谁课诽谊调谆谈请谅论谍谐咨讳讽诸谚诺谋谓誊诌谎谜谤谦讲谢谣谣谬谨谩哗证讥识谭谱噪毁译议谴护誉读变谗让谰赞溪岂竖丰艳猪狸猫贝贞负财贡贫货贩贪贯责贮贰贵贬买贷费贴贸贺赂赁贿资贾贼赊宾赐赏赔贤卖贱赋质账赌赖赚购赛赘赠赞赡赢赃赎赣赃赶赵趋迹践逾踊迹踪踌跃蹿躯车轧轨军轩软轴较载挽辅轻辆辉辊辈轮辑输辐辗舆辖辕转辙轿轰办辞辫辩农回径这连周进游运过达违遥逊递远溯适迟绕迁选遗辽迈还边逻邮乡邹郧邓郑邻郸酝丑酝糖医酱酿衅释厘钉针钓扣钒钎钥钠钝钩钞钮钧钟钙铃铀钾巨钻铂钳铆铅钵钩铰铬银铜铣铭衔铱锐销锈锑铝锌钡锋锄铺锐锯钢录锥锤锭钱锦锚锡错录锰表锨炼锅镀铡锻锹键锗针钟镁镑镰锁锤钨镐镇镇镍旋链铲镜锈镣钟镰镭铁铸鉴鉴钥镶镊锣钻凿长门闪闭开闰闲闲间闸阂阁合阀闺闽阅阅阉阎板暗阔阑闯关阐辟陕升阵阴陈陆阳队阶陨际随险隐陇隶只虽双雏杂鸡离难云电沾雾灵静巩秋千韦韧韩韵响页顶顷项顺须颂预顽颁顿颇领颐头颊颈颓频颓颗题额颜颜愿颠类顾颤显颅颧风台刮飘飞饥饭饮饲饱饰饺饼养饵馁饿余饯馅馆糊喂馏馒馈饥饶馋马驭冯驮驰驯驳驻驹驾驶驼骂骇骆骏骋骑骗腾骚骡驱骄验惊骤驴肮脏体发松胡须斗闹哄郁鱼鲁鲍鲜鲤鲸鳃鳖鳞鸟凤鸣鸦鸵鸳鸯鸭鸿鸽鹃鹅鹏雕鹊鹤鸡鸥鹰卤咸碱盐丽麦面面曲曲面么么黄点党霉冬齐斋齿龄出啮龋龙庞龚龟";
  let t2s = null;
  function toSimplified(text) {
    if (!/[\u4e00-\u9fff]/.test(text)) return text;
    if (!t2s) { t2s = new Map(); for (let i = 0; i < T2S_FROM.length; i++) t2s.set(T2S_FROM[i], T2S_TO[i]); }
    let out = '';
    for (const ch of text) out += t2s.get(ch) || ch;
    return out;
  }
  const WORD_RUN = /[\p{L}\p{N}\p{M}]+/gu;
  function normalize(text) {
    if (typeof text !== 'string' || !text) return '';
    const runs = toSimplified(text.normalize('NFKC').toLowerCase()).match(WORD_RUN);
    return runs ? runs.join(' ') : '';
  }
  /* Kana -> Hepburn-style romaji so 「ぎゅって」 meets "gyutte" and 「ヨルシカ」 "Yorushika". */
  const KANA = {
    あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o', か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko', が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
    さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so', ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo', た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
    だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do', な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no', は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
    ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo', ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po', ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
    や: 'ya', ゆ: 'yu', よ: 'yo', ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro', わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ん: 'n', ゔ: 'vu', ゎ: 'wa',
  };
  const SMALL_Y = { ゃ: 'ya', ゅ: 'yu', ょ: 'yo' }, SMALL_V = { ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o' };
  const HAS_KANA = /[\u3041-\u30ff]/;
  function romanize(text) {
    let out = '', double = false;
    for (let ch of String(text)) {
      const code = ch.charCodeAt(0);
      if (code >= 0x30a1 && code <= 0x30f6) ch = String.fromCharCode(code - 0x60); // katakana -> hiragana
      if (ch === 'っ') { double = true; continue; }
      if (ch === 'ー') { const v = /[aeiou]$/.exec(out); if (v) out += v[0]; continue; }
      if (SMALL_Y[ch] && /[a-z]i$/.test(out)) { out = /(sh|ch|j)i$/.test(out) ? out.slice(0, -1) + SMALL_Y[ch].slice(1) : out.slice(0, -1) + SMALL_Y[ch]; continue; }
      if (SMALL_V[ch] && /[a-z][aeiou]$/.test(out)) { out = out.slice(0, -1) + SMALL_V[ch]; continue; }
      let roman = KANA[ch] || SMALL_Y[ch] || SMALL_V[ch];
      if (roman === undefined) { out += ch; double = false; continue; }
      if (double) { out += roman.startsWith('ch') ? 't' : roman[0]; double = false; }
      out += roman;
    }
    return out;
  }
  /* Romaji spellings vary (ō/ou/o, wo/o): compare without diacritics and doubled vowels. */
  const latinKey = text => normalize(text).normalize('NFD').replace(/\p{M}+/gu, '').replace(/([aeiou])\1+/g, '$1').replace(/ou/g, 'o').replace(/ /g, '');
  function textSimilarity(left, right) {
    const base = editSimilarity(normalize(left), normalize(right));
    if (base === 1 || !(HAS_KANA.test(left || '') || HAS_KANA.test(right || ''))) return base;
    return Math.max(base, editSimilarity(latinKey(romanize(normalize(left))), latinKey(romanize(normalize(right)))));
  }
  function editSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const ac = Array.from(a), bc = Array.from(b);
    /* Bound malicious provider metadata and the quadratic edit-distance work. */
    if (ac.length > 512 || bc.length > 512) return 0;
    const row = new Uint32Array(bc.length + 1);
    for (let j = 0; j <= bc.length; j++) row[j] = j;
    for (let i = 1; i <= ac.length; i++) {
      let previous = row[0]; row[0] = i;
      for (let j = 1; j <= bc.length; j++) {
        const old = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (ac[i - 1] !== bc[j - 1] ? 1 : 0));
        previous = old;
      }
    }
    return 1 - row[bc.length] / Math.max(ac.length, bc.length);
  }
  /* Recording variants: a candidate is only eligible when it carries the same set. */
  const VERSION_PATTERNS = [
    /(^|[^a-z])(live|concert)([^a-z]|$)|现场|演唱会|ライブ/,
    /(^|[^a-z])cover([^a-z]|$)|翻唱|原唱|翻自|カバー/,
    /(^|[^a-z])(instrumental|karaoke|off ?vocal|inst)([^a-z]|$)|伴奏|纯音乐|カラオケ|インスト/,
    /(^|[^a-z])(remix|mix|dj)([^a-z]|$)|混音|dj版|リミックス/,
    /sped[ -]?up|slowed|nightcore|加速|慢速|降调|升调/,
    /radio[ -]?edit|tv[ -]?(size|ver|edit)|short[ -]?ver|game[ -]?size|剪辑|ショート/,
    /(^|[^a-z])acoustic([^a-z]|$)|不插电/,
    /(^|[^a-z])(piano|orchestra|orchestral|music box|8[ -]?bit|lo-?fi)([^a-z]|$)|钢琴|八音盒|管弦/,
    /(^|[^a-z])demo([^a-z]|$)/,
    /* Any other "<something> ver." tag (LDDC): character / anime / band versions. */
    /[^\s(\[【〔（-]+(?:[ -]|(?<![a-z]))ver(?:sion)?\.?(?=$|[\s)\]】〕）-])|版(?=$|[\s)\]】〕）-])/,
  ];
  /* "Original Mix" / "Album Version" name the default recording, not a variant. */
  const NEUTRAL_VERSION = /(original|extended|album|main)[ -]?mix|(album|single|original|main|lp|explicit|clean|full|remaster(ed)?|stereo|mono)[ -]?ver(sion)?\.?/g;
  function versionFlags(title) {
    const lower = toSimplified(String(title || '').normalize('NFKC').toLowerCase()).replace(NEUTRAL_VERSION, '');
    let result = 0;
    VERSION_PATTERNS.forEach((pattern, i) => { if (pattern.test(lower)) result |= 1 << i; });
    return result;
  }
  /* Notes that never change the recording (Lyricify's "SpecialCompare"): featured
   * artists, explicit / deluxe / bonus / remaster tags, "From <film>", OST notes. */
  const NEUTRAL_NOTE = new RegExp('^(?:' + [
    'feat\\.?\\s.*', 'ft\\.?\\s.*', 'featuring\\s.*', 'with\\s.*', 'prod\\.?\\s.*', 'explicit', 'clean', 'bonus(?: track)?',
    'deluxe(?: edition| version)?', '(?:\\d{4}\\s+)?(?:digital(?:ly)?\\s+)?remaster(?:ed)?(?:\\s+\\d{4})?(?:\\s+version)?', 'mono', 'stereo',
    '(?:album|single|original|main|lp)\\s+version', '(?:original|extended|album)\\s+mix', 'from\\s.*', 'taken from\\s.*', '.*\\bost\\b.*',
    '.*(?:主题曲|主題曲|插曲|片头曲|片頭曲|片尾曲|主題歌|主题歌|挿入歌|オープニング|エンディング|テーマ|原声带|原聲帶|电视剧|電視劇|电影|電影|动画|動畫|アニメ|ゲーム).*',
  ].join('|') + ')$', 'i');
  const BRACKETED = /\s*[（(【\[]([^（()）【】\[\]]*)[）)】\]]/g;
  const DASH_NOTE = /\s+[-–—]\s+(.+)$/;
  /* Title without neutral notes; version notes (Live, Remix, …) are kept. */
  function titleCore(title) {
    let t = String(title || '').normalize('NFKC');
    t = t.replace(BRACKETED, (match, inner) => NEUTRAL_NOTE.test(inner.trim()) ? '' : match);
    const dash = DASH_NOTE.exec(t);
    if (dash && NEUTRAL_NOTE.test(dash[1].trim())) t = t.slice(0, dash.index);
    return t.replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, '').trim();
  }
  const titleBase = titleCore;
  /* Trailing bracketed notes such as QQ's translated titles 「ぎゅって (紧紧拥住)」.
   * Version markers (Live/Remix/…) are still compared on the full title. */
  const TRAILING_NOTE = /\s*[（(【\[][^（()）【】\[\]]*[）)】\]]\s*$/;
  /** aliases: provider-side alternative titles (NetEase alias / transNames, QQ subtitle). */
  function titleSimilarity(left, right, aliases) {
    const a = titleCore(left), b = titleCore(right);
    let best = textSimilarity(a, b);
    if (best === 1) return 1;
    /* A note on one side only (Lyricify "BracketsCompare"): same song, slightly less certain. */
    const at = a.replace(TRAILING_NOTE, ''), bt = b.replace(TRAILING_NOTE, '');
    if ((at !== a || bt !== b) && at && bt) best = Math.max(best, 0.95 * textSimilarity(at, bt));
    /* Dual-language titles are accepted only when explicitly delimited. */
    const av = a.split(/\s+\/\s+/), bv = b.split(/\s+\/\s+/);
    if (av.length > 1 || bv.length > 1) for (const x of av) for (const y of bv) best = Math.max(best, textSimilarity(x, y));
    for (const alias of (aliases || []).slice(0, 8)) best = Math.max(best, 0.97 * textSimilarity(a, titleCore(alias)));
    return best;
  }
  /* One credited artist and its alternative names: "A/B" combined entries,
   * "角色 (CV: 声优)" and "歌手 (别名)" (LDDC artist_str2list). */
  function artistNames(name) {
    const full = String(name || '').normalize('NFKC').trim();
    const names = new Set([full]);
    const cv = /^(.*?)\s*[(（]\s*(?:cv|vo|vocal|唱)\s*[.:：]?\s*([^)）]+)[)）]\s*$/i.exec(full) || /^(.*?)\s*[(（]([^)）]+)[)）]\s*$/.exec(full);
    if (cv) { names.add(cv[1].trim()); names.add(cv[2].trim()); }
    for (const part of full.split(/\s*(?:[/／、;；,，]|\s(?:feat\.?|ft\.?|featuring)\s)\s*/i)) if (part) names.add(part);
    return [...names].filter(n => normalize(n));
  }
  function entrySimilarity(left, right) {
    let best = 0;
    for (const x of left) for (const y of right) { best = Math.max(best, textSimilarity(x, y)); if (best === 1) return 1; }
    return best;
  }
  const VARIOUS = /^(various artists?|群星|羣星|华语群星|v\.?\s?a\.?)$/i;
  /* The Spotify main artist must appear among the candidate's artists (order does
   * not matter); the share of artists found on both sides refines the score. */
  function artistSimilarity(left, right) {
    if (!left || !left.length || !right || !right.length) return 0;
    const L = left.map(artistNames).filter(n => n.length), R = right.map(artistNames).filter(n => n.length);
    if (!L.length || !R.length) return 0;
    if (L.length > 3 && R.length === 1 && R[0].some(n => VARIOUS.test(n))) return 0.8;
    const bestL = L.map(l => Math.max(...R.map(r => entrySimilarity(l, r))));
    const principal = bestL[0];
    /* A shared guest performer cannot substitute for the main artist. */
    if (principal < 0.75) return principal;
    const bestR = R.map(r => Math.max(...L.map(l => entrySimilarity(l, r))));
    const found = bestL.filter(s => s >= 0.8).length + bestR.filter(s => s >= 0.8).length;
    return 0.8 * principal + 0.2 * found / (L.length + R.length);
  }
  /* "Eason Chan" vs 「陈奕迅」: names in different scripts cannot be compared by text. */
  const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/, LATIN = /[a-z]/i;
  function scriptsDiffer(left, right) {
    const a = String(left || ''), b = String(right || '');
    return !!a && !!b && ((CJK.test(a) && !CJK.test(b) && LATIN.test(b)) || (CJK.test(b) && !CJK.test(a) && LATIN.test(a)));
  }

  /* ----------------------------------------------------------- match ---- */
  /* QQ Music reports whole seconds: its real length lies in [interval, interval + 1 s). */
  function durationDelta(trackMs, candidate) {
    const c = candidate.duration_ms;
    if (!(trackMs > 0) || !(c > 0)) return -1;
    if (trackMs <= c) return c - trackMs;
    return Math.max(0, trackMs - c - (candidate.provider === 'qq' ? 999 : 0));
  }
  /* Lyricify's duration grades (0 / 300 / 700 / 1500 / 3500 ms). */
  function durationScore(delta) {
    if (delta < 0) return 0;
    return delta === 0 ? 1 : delta < 300 ? 0.95 : delta < 700 ? 0.9 : delta < 1500 ? 0.8 : delta < 3500 ? 0.55 : 0;
  }
  const WEIGHTS = { title: 40, artist: 30, album: 10, duration: 20 };
  function matchScore(track, candidate) {
    const c = candidate;
    c.eligible = false; c.score = 0;
    c.delta_ms = durationDelta(track.duration_ms, c);
    c.title_score = titleSimilarity(track.title, c.title, c.aliases);
    c.artist_score = artistSimilarity(track.artists, c.artists);
    const album = !!(track.album && c.album), duration = c.delta_ms >= 0;
    c.album_score = album ? Math.max(textSimilarity(track.album, c.album), textSimilarity(titleCore(track.album), titleCore(c.album))) : 0;
    c.duration_score = durationScore(c.delta_ms);
    /* Missing optional fields do not count against a candidate: weights are re-normalised. */
    const total = WEIGHTS.title + WEIGHTS.artist + (album ? WEIGHTS.album : 0) + (duration ? WEIGHTS.duration : 0);
    c.score = 100 * (WEIGHTS.title * c.title_score + WEIGHTS.artist * c.artist_score +
      (album ? WEIGHTS.album * c.album_score : 0) + (duration ? WEIGHTS.duration * c.duration_score : 0)) / total;
    const sameVersion = versionFlags(track.title) === versionFlags(c.title);
    /* A different recording (Live, Remix, …) must not look like a near-perfect result. */
    if (!sameVersion) c.score *= 0.6;
    let reason;
    if (c.delta_ms < 0) reason = '总时长未知';
    else if (c.delta_ms > DURATION_TOLERANCE) reason = '总时长相差超过 3 秒';
    else if (!sameVersion) reason = '歌曲版本不一致';
    else if (c.title_score < 0.8) reason = '歌名相似度不足';
    else if (c.artist_score < 0.75) reason = scriptsDiffer((track.artists || [])[0], (c.artists || [])[0]) ? '艺术家名称语言不同，需歌词比对或手动确认' : '主艺术家不匹配';
    else if (c.score < 80) reason = '综合匹配分数不足';
    else { c.eligible = true; reason = '通过歌名、艺术家、专辑和时长检查'; }
    c.reason = reason;
    return c;
  }
  const strcmp = (a, b) => (a || '') < (b || '') ? -1 : (a || '') > (b || '') ? 1 : 0;
  function matchSort(candidates, preferred) {
    return candidates.sort((l, r) => {
      if (l.eligible !== r.eligible) return l.eligible ? -1 : 1;
      if (Math.abs(l.score - r.score) > 0.0001) return l.score > r.score ? -1 : 1;
      const lp = l.provider === preferred, rp = r.provider === preferred;
      if (lp !== rp) return lp ? -1 : 1;
      return strcmp(l.id, r.id);
    });
  }
  /* The preferred source wins when its best eligible result is within this many points. */
  const PREFERRED_MARGIN = 10;
  /* Every eligible candidate already shares title, main artist, version and length (±3 s),
   * so the best one is taken (LDDC / Lyricify) instead of refusing near-ties. */
  function matchSelect(candidates, preferred) {
    let best = null, pref = null;
    for (const c of candidates) {
      if (!c.eligible) continue;
      if (!best || c.score > best.score) best = c;
      if (c.provider === preferred && (!pref || c.score > pref.score)) pref = c;
    }
    if (best && pref && best !== pref && best.score - pref.score <= PREFERRED_MARGIN) return pref;
    return best;
  }
  /* Widening query cascade (Lyricify / LDDC): full metadata, then without neutral
   * notes, then the title alone (only used when nothing eligible turned up). */
  function searchQueries(track) {
    const artist = ((track.artists && track.artists[0]) || '').trim();
    const title = String(track.title || '').trim(), core = titleCore(title) || title;
    const out = [];
    const add = (text, titleOnly) => { text = text.trim(); if (text && !out.some(q => normalize(q.text) === normalize(text))) out.push({ text, titleOnly }); };
    add(`${title} ${artist}`, false);
    add(`${core} ${artist}`, false);
    if (artist) add(core, true);
    return out;
  }

  /* ----------------------------------------------------------- model ---- */
  function at(node, path) {
    if (!path) return node;
    for (const part of path.split('/')) {
      if (node == null || typeof node !== 'object') return undefined;
      node = node[part];
    }
    return node;
  }
  const str = (node, path) => { const v = at(node, path); return typeof v === 'string' ? v : ''; };
  const int = (node, path) => {
    const v = at(node, path);
    if (typeof v === 'number' && isFinite(v)) return Math.trunc(v);
    if (typeof v === 'string') { const n = parseInt(v, 10); return isFinite(n) ? n : 0; }
    return 0;
  };
  function cyrb53(text) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  }
  function trackKey(track) {
    if (track.uri && !track.uri.endsWith('/NoTrack')) return track.uri;
    const raw = [normalize(track.title), normalize((track.artists || []).join('|')), normalize(track.album), track.duration_ms || 0].join('\n');
    return 'metadata:' + cyrb53(raw);
  }
  function spotifyId(uri) {
    if (!uri) return null;
    let id = null;
    if (uri.startsWith('spotify:track:')) id = uri.slice(14);
    else if (uri.startsWith('https://open.spotify.com/track/')) id = uri.slice(31);
    if (!id || !/^[A-Za-z0-9]{22}(\?.*)?$/.test(id)) return null;
    return id.slice(0, 22);
  }
  function trackEqual(l, r) {
    return !!l && !!r && l.uri === r.uri && l.title === r.title && l.album === r.album && l.duration_ms === r.duration_ms &&
      (l.artists || []).join('\n') === (r.artists || []).join('\n');
  }
  function candidateFromJson(node) {
    if (!node || typeof node !== 'object' || !str(node, 'provider') || !str(node, 'id')) return null;
    const provider = str(node, 'provider');
    if (!PROVIDERS.includes(provider)) return null;
    const strings = (value, max) => Array.isArray(value) ? value.filter(a => typeof a === 'string').slice(0, max).map(a => a.slice(0, 300)) : [];
    return {
      provider, id: str(node, 'id'), mid: str(node, 'mid'), title: str(node, 'title'), album: str(node, 'album'),
      duration_ms: int(node, 'duration_ms'), verified: node.verified === true,
      artists: strings(node.artists, 50), aliases: strings(node.aliases, 8),
    };
  }
  function candidateJson(c) {
    const json = { id: c.id, mid: c.mid || '', provider: c.provider, title: c.title || '', album: c.album || '', duration_ms: c.duration_ms || 0, artists: (c.artists || []).slice() };
    if (c.aliases && c.aliases.length) json.aliases = c.aliases.slice(0, 8);
    if (c.verified) json.verified = true;
    return json;
  }

  /* ---------------------------------------------------------- lyrics ---- */
  const STAMP = /^(\d+):(\d+(?:\.\d*)?)/;
  function timestamp(text, from) {
    const m = STAMP.exec(text.slice(from, from + 24));
    if (!m) return null;
    const minutes = parseInt(m[1], 10), seconds = parseFloat(m[2]);
    if (minutes > 10000 || !(seconds >= 0 && seconds < 60)) return null;
    return { time: minutes * 60000 + Math.round(seconds * 1000), end: from + m[0].length };
  }
  function enhancedWords(raw) {
    const words = []; let text = ''; let cursor = 0;
    while (cursor < raw.length) {
      if (raw[cursor] !== '<') { text += raw[cursor++]; continue; }
      const stamp = timestamp(raw, cursor + 1);
      if (!stamp || raw[stamp.end] !== '>') { text += raw[cursor++]; continue; }
      const next = raw.indexOf('<', stamp.end + 1);
      const part = next >= 0 ? raw.slice(stamp.end + 1, next) : raw.slice(stamp.end + 1);
      if (words.length) words[words.length - 1].end_time_ms = stamp.time;
      if (part) { words.push({ text: part, start_time_ms: stamp.time, end_time_ms: stamp.time }); text += part; }
      cursor = next >= 0 ? next : raw.length;
    }
    return { text, words };
  }
  /* Bumped whenever parsing changes, so lyrics stored by an older parser get re-fetched. */
  const PARSER_VERSION = 2;
  function emptyLyrics(source) { return { source, provider: source, sync_type: 'line', lines: [], parser: PARSER_VERSION }; }
  function parseLrc(lrc, translation, source) {
    const result = emptyLyrics(source);
    if (typeof lrc !== 'string' || lrc.length > MAX_RESPONSE) return result;
    const rawLines = lrc.split('\n');
    let lines = [], offset = 0, hasWords = false;
    for (let i = 0; i < rawLines.length && lines.length < 10000; i++) {
      let p = rawLines[i].trim();
      if (p.charCodeAt(0) === 0xfeff) p = p.slice(1);
      if (p.startsWith('[offset:')) { offset = Math.max(-3600000, Math.min(3600000, parseInt(p.slice(8), 10) || 0)); continue; }
      const times = []; let pos = 0;
      while (p[pos] === '[') {
        const stamp = timestamp(p, pos + 1);
        if (!stamp || p[stamp.end] !== ']') break;
        times.push(stamp.time); pos = stamp.end + 1;
      }
      const body = p.slice(pos);
      for (const time of times) {
        const parsed = enhancedWords(body);
        hasWords = hasWords || parsed.words.length > 0;
        lines.push({ text: parsed.text, start_time_ms: time, end_time_ms: time, words: parsed.words });
      }
    }
    if (!lines.length) {
      result.sync_type = 'unsynced';
      for (const raw of rawLines) {
        const text = raw.trim();
        if (text && text[0] !== '[' && lines.length < 10000) lines.push({ text, start_time_ms: 0, end_time_ms: 0, words: [] });
      }
    } else if (hasWords) result.sync_type = 'word';
    lines.sort((a, b) => a.start_time_ms - b.start_time_ms);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const start = line.start_time_ms - offset;
      const end = i + 1 < lines.length ? lines[i + 1].start_time_ms - offset : start + 10000;
      line.start_time_ms = start; line.end_time_ms = Math.max(start, end);
      for (const word of line.words) {
        const ws = word.start_time_ms - offset, we = word.end_time_ms - offset;
        word.start_time_ms = ws; word.end_time_ms = we > ws ? we : Math.max(ws, line.end_time_ms);
      }
    }
    result.lines = lines;
    if (translation) mergeTranslation(lines, translation, source);
    return result;
  }
  function mergeTranslation(lines, translation, source) {
    const translated = parseLrc(translation, null, source).lines.filter(l => l.text.trim() && l.text.trim() !== '//');
    /* Blank/interlude lines must not swallow a translation meant for a real line. */
    const targets = [];
    lines.forEach((line, i) => { if (line.text.trim()) targets.push(i); });
    if (!translated.length || !targets.length) return;
    /* NetEase normally stamps a translation with exactly the same time as its original line:
     * take those pairs first, strictly. */
    const rest = [];
    const byTime = new Map();
    for (const i of targets) { const k = lines[i].start_time_ms; if (!byTime.has(k)) byTime.set(k, i); }
    for (const t of translated) {
      const i = byTime.get(t.start_time_ms);
      if (i !== undefined && !lines[i].translated_text) lines[i].translated_text = t.text; else rest.push(t);
    }
    /* Word-timed (yrc) timestamps can drift from the translation's: align what is left
     * monotonically to the nearest original line that still has no translation. */
    const TOLERANCE = 3000;
    const free = targets.filter(i => !lines[i].translated_text);
    let from = 0;
    for (const t of rest) {
      let best = -1, bestDiff = Infinity;
      for (let k = from; k < free.length; k++) {
        const diff = Math.abs(lines[free[k]].start_time_ms - t.start_time_ms);
        if (diff < bestDiff) { best = k; bestDiff = diff; }
        else if (lines[free[k]].start_time_ms > t.start_time_ms) break;
      }
      if (best < 0 || bestDiff > TOLERANCE) continue;
      lines[free[best]].translated_text = t.text; from = best + 1;
    }
  }
  function spotifyLyrics(response) {
    const result = emptyLyrics('spotify');
    const root = at(response, 'lyrics');
    const source = at(root, 'lines');
    if (!Array.isArray(source)) return result;
    const sync = str(root, 'syncType');
    result.sync_type = sync === 'SYLLABLE_SYNCED' ? 'word' : sync === 'LINE_SYNCED' ? 'line' : 'unsynced';
    result.language = str(root, 'language');
    result.provider = str(root, 'provider');
    result.provider_name = str(root, 'providerDisplayName');
    for (let i = 0; i < source.length; i++) {
      const input = source[i];
      let text = str(input, 'text') || str(input, 'words');
      const start = int(input, 'startTimeMs');
      let end = int(input, 'endTimeMs');
      if (end <= start) end = i + 1 < source.length ? int(source[i + 1], 'startTimeMs') : start + 10000;
      const line = { text, start_time_ms: start, end_time_ms: end, words: [] };
      const syllables = Array.isArray(input.syllables) ? input.syllables : Array.isArray(input.words) ? input.words : null;
      if (syllables && syllables.length) {
        let joined = '';
        syllables.forEach((part, j) => {
          const partText = str(part, 'string') || str(part, 'text');
          const ws = int(part, 'startTimeMs');
          let we = int(part, 'endTimeMs');
          if (we <= ws) we = j + 1 < syllables.length ? int(syllables[j + 1], 'startTimeMs') : end;
          line.words.push({ text: partText, start_time_ms: ws, end_time_ms: we }); joined += partText;
        });
        if (!text) line.text = joined;
      }
      result.lines.push(line);
    }
    if (result.sync_type !== 'word') for (const line of result.lines) line.words = [];
    return result;
  }
  function lyricsUsable(lyrics) {
    return !!(lyrics && Array.isArray(lyrics.lines) && lyrics.lines.some(line => line && line.text));
  }
  function lyricsIndex(lyrics, position) {
    const lines = lyrics && lyrics.lines;
    if (!Array.isArray(lines)) return -1;
    let low = 0, high = lines.length - 1, found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (lines[middle].start_time_ms <= position) { found = middle; low = middle + 1; } else high = middle - 1;
    }
    return found;
  }
  /* Share of the reference's distinct lines (first 40) found in the candidate;
   * kana lines are also compared in romaji. Used to confirm a match by content. */
  function lyricsSimilarity(reference, candidate) {
    const keys = lyrics => {
      const seen = new Map();
      for (const line of (lyrics && lyrics.lines) || []) {
        if (!line.text || CREDIT_LINE.test(line.text)) continue;
        const n = normalize(line.text);
        if (n && !seen.has(n)) seen.set(n, HAS_KANA.test(n) ? latinKey(romanize(n)) : latinKey(n));
      }
      return [...seen];
    };
    const ref = keys(reference).slice(0, 40), cand = keys(candidate);
    if (ref.length < 4 || cand.length < 4) return 0;
    const exact = new Set(cand.flatMap(([n, k]) => [n, k]));
    let hit = 0;
    for (const [n, k] of ref) {
      if (exact.has(n) || exact.has(k) || cand.some(([cn, ck]) => editSimilarity(cn, n) >= 0.8 || editSimilarity(ck, k) >= 0.8)) hit++;
    }
    return hit / ref.length;
  }
  function stamp(time, left, right) {
    time = Math.max(0, Math.round(time));
    const pad = (n, w) => String(n).padStart(w, '0');
    return left + pad(Math.floor(time / 60000), 2) + ':' + pad(Math.floor(time / 1000) % 60, 2) + '.' + pad(time % 1000, 3) + right;
  }
  function exportLrc(lyrics) {
    let text = '';
    for (const line of (lyrics && lyrics.lines) || []) {
      if (lyrics.sync_type !== 'unsynced') text += stamp(line.start_time_ms, '[', ']');
      if (line.words && line.words.length) {
        line.words.forEach((word, j) => {
          text += stamp(word.start_time_ms, '<', '>') + word.text;
          if (j + 1 === line.words.length) text += stamp(word.end_time_ms, '<', '>');
        });
      } else text += line.text;
      text += '\n';
    }
    return text;
  }

  /* ------------------------------------------------------- providers ---- */
  function addSong(array, provider, song) {
    if (!song || typeof song !== 'object' || Array.isArray(song) || array.length >= 100) return;
    const qq = provider === 'qq';
    const title = str(song, qq ? 'title' : 'name');
    const id = int(song, 'id');
    if (!id || !title) return;
    let album = str(song, qq ? 'album/title' : 'album/name');
    if (!album) album = str(song, qq ? 'album/name' : 'al/name');
    let duration = qq ? Math.max(0, Math.min(86400, int(song, 'interval'))) * 1000 : (int(song, 'duration') || int(song, 'dt'));
    if (duration < 0 || duration > 86400000) duration = 0;
    let artists = at(song, qq ? 'singer' : 'artists');
    if (!artists) artists = at(song, 'ar');
    artists = Array.isArray(artists) ? artists.slice(0, 50).map(a => str(a, 'name')) : [];
    /* Alternative titles: NetEase alias / transNames, QQ name / subtitle (e.g. a translated title). */
    const aliases = [];
    const alias = text => { if (typeof text === 'string' && text.trim() && text !== title && !aliases.includes(text) && aliases.length < 8) aliases.push(text.slice(0, 300)); };
    for (const path of qq ? ['name', 'subtitle'] : ['alias', 'transNames', 'alia', 'tns']) {
      const value = at(song, path);
      if (Array.isArray(value)) value.forEach(alias); else alias(value);
    }
    const candidate = { provider, id: String(id), mid: str(song, 'mid'), title, album, duration_ms: duration, artists, aliases };
    if (array.some(o => o.id === candidate.id && o.provider === provider)) return;
    array.push(candidate);
  }
  function providerCandidates(provider, response) {
    const result = [];
    for (const path of ['result/songs', 'songs', 'req_1/data/body/song/list', 'data']) {
      const node = at(response, path);
      if (!Array.isArray(node)) continue;
      for (const song of node) {
        if (result.length >= 100) break;
        addSong(result, provider, song);
        const group = at(song, 'group');
        if (Array.isArray(group)) for (const item of group) { if (result.length >= 100) break; addSong(result, provider, item); }
      }
      break;
    }
    return result;
  }
  const NETEASE = 'https://music.163.com';
  const QQ = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
  /* Builds the HTTP request for a provider search, including direct song links. */
  function searchRequest(provider, query) {
    const normalized = normalize(query);
    if (provider === 'qq') {
      const request = {
        method: 'POST', url: QQ, headers: { Referer: 'https://c.y.qq.com/', 'Content-Type': 'application/json' },
        body: JSON.stringify({ req_1: { method: 'DoSearchForQQMusicDesktop', module: 'music.search.SearchCgiService', param: { num_per_page: 20, page_num: 1, search_type: 0, query: normalized } } }),
      };
      if (query.includes('y.qq.com/')) {
        const m = /(?:songDetail|song)\/([A-Za-z0-9]{1,64})/.exec(query);
        if (m) {
          request.url = 'https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg';
          request.body = `songmid=${m[1]}&format=jsonp&callback=getOneSongInfoCallback&g_tk=5381&platform=yqq&outCharset=utf8`;
          request.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
      }
      return request;
    }
    let url = `${NETEASE}/api/search/get/web?s=${encodeURIComponent(normalized)}&type=1&offset=0&total=false&limit=20`;
    if (query.includes('music.163.com/')) {
      const m = /(?:[?&]id=|song\/)(\d+)/.exec(query);
      if (m) url = `${NETEASE}/api/song/detail/?id=${m[1]}&ids=%5B${m[1]}%5D`;
    }
    return { method: 'GET', url, headers: { Referer: 'https://music.163.com/' }, body: null };
  }
  /* Ordered list of lyric requests; later entries are fallbacks tried on errors. */
  function fetchRequests(candidate) {
    if (candidate.provider === 'qq') {
      const requests = [fetchRequest(candidate)];
      /* Legacy web endpoint as a fallback (base64 lyric/trans, -1901 = none). */
      if (candidate.mid) requests.push({
        method: 'POST', url: 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg',
        headers: { Referer: 'https://y.qq.com/', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `songmid=${encodeURIComponent(candidate.mid)}&g_tk=5381&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`,
      });
      return requests;
    }
    const id = encodeURIComponent(candidate.id), headers = { Referer: 'https://music.163.com/' };
    return [
      /* Current endpoint: also returns word-timed yrc + its translation ytlrc. */
      { method: 'GET', url: `${NETEASE}/api/song/lyric/v1?id=${id}&cp=false&lv=0&kv=0&tv=0&rv=0&yv=0&ytv=0&yrv=0`, headers, body: null },
      { method: 'GET', url: `${NETEASE}/api/song/lyric?id=${id}&lv=-1&kv=-1&tv=-1`, headers, body: null },
    ];
  }
  function fetchRequest(candidate) {
    if (candidate.provider === 'qq') {
      return {
        method: 'POST', url: QQ, headers: { Referer: 'https://c.y.qq.com/', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comm: { ct: 24, cv: 4747474, format: 'json', g_tk: '5381', g_tk_new_20200303: '5381', inCharset: 'utf-8', outCharset: 'utf-8', platform: 'yqq.json', uin: 0 },
          req_1: { module: 'music.musichallSong.PlayLyricInfo', method: 'GetPlayLyricInfo', param: { qrc: 0, qrc_t: 0, roma: 0, trans: 1, songID: parseInt(candidate.id, 10) || 0, songMID: candidate.mid || '' } },
        }),
      };
    }
    return { method: 'GET', url: `${NETEASE}/api/song/lyric?id=${encodeURIComponent(candidate.id)}&lv=-1&kv=-1&tv=-1`, headers: { Referer: 'https://music.163.com/' }, body: null };
  }
  function decodeLyric(text) {
    if (!text) return '';
    if (text.includes('[')) return text;
    try {
      const binary = atob(text);
      const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_) { return ''; }
  }
  class ProviderError extends Error {
    constructor(message, kind) { super(message); this.kind = kind || 'failed'; }
  }
  /* Parses a provider response body; throws ProviderError on service errors. */
  function parseProviderBody(provider, body) {
    let raw;
    try { raw = JSON.parse(body); } catch (_) {
      const start = body ? body.indexOf('(') : -1, end = body ? body.lastIndexOf(')') : -1;
      if (start >= 0 && end > start) { try { raw = JSON.parse(body.slice(start + 1, end)); } catch (_) { /* fallthrough */ } }
    }
    if (raw === undefined) throw new ProviderError(`${PROVIDER_NAMES[provider]} 返回了无法解析的数据`);
    const code = int(raw, 'code'), inner = int(raw, 'req_1/code');
    /* GetPlayLyricInfo answers 24001 when QQ has no lyric for the song. */
    if (provider === 'qq' && code === 0 && inner === 24001) return raw;
    if (provider === 'qq' && code === -1901) return raw;
    /* QQ answers 2001 intermittently (anti-spam); callers retry it once. */
    if ((code !== 0 && code !== 200) || inner !== 0) {
      const value = inner || code;
      if (value === 2001) throw new ProviderError(`${PROVIDER_NAMES[provider]} 暂时限流（2001），请稍后重试`, 'transient');
      throw new ProviderError(`${PROVIDER_NAMES[provider]} 服务返回错误码 ${value}`, 'failed');
    }
    return raw;
  }
  /* NetEase v1 lyrics carry credits as JSON lines ({"t":0,"c":[...]}); drop them. */
  const dropJsonLines = text => (text || '').split('\n').filter(line => !line.trim().startsWith('{')).join('\n');
  const CREDIT_LINE = /^\s*(?:作词|作詞|作曲|编曲|編曲|词|詞|曲|制作人|製作人|监制|監製|制作|製作|混音|母带|母帶|和声|和聲|录音|錄音|吉他|贝斯|鼓|弦乐|配唱|原唱|翻唱|演唱|歌手|出品|发行|發行|OP|SP|Lyrics?(?: by)?|Lyricist|Written by|Composer|Composed by|Music(?: by)?|Arrange(?:r|d by)|Producer|Produced by|Vocal(?:s| by)?)\s*[:：]/i;
  const INSTRUMENTAL = /纯音乐[，,]?\s*请欣赏|純音樂[，,]?\s*請欣賞|此歌曲为没有填词的纯音乐|instrumental/i;
  /* Word-timed NetEase lyrics: [lineStart,lineDur](wordStart,wordDur,0)text… */
  function parseYrc(yrc, translation, source) {
    const result = emptyLyrics(source);
    if (typeof yrc !== 'string' || yrc.length > MAX_RESPONSE) return result;
    const TOKEN = /\((\d+),(\d+),-?\d+\)/g;
    for (const raw of yrc.split('\n')) {
      const m = /^\[(\d+),(\d+)\](.*)$/.exec(raw.trim());
      if (!m || result.lines.length >= 10000) continue;
      const start = +m[1], body = m[3], tokens = [];
      let t; TOKEN.lastIndex = 0;
      while ((t = TOKEN.exec(body))) tokens.push({ index: t.index, end: TOKEN.lastIndex, start: +t[1], dur: +t[2] });
      const words = tokens.map((tk, i) => ({ text: body.slice(tk.end, i + 1 < tokens.length ? tokens[i + 1].index : body.length), start_time_ms: tk.start, end_time_ms: tk.start + tk.dur }))
        .filter(w => w.text);
      const text = words.length ? words.map(w => w.text).join('') : body.replace(TOKEN, '');
      result.lines.push({ text, start_time_ms: start, end_time_ms: start + Math.max(0, +m[2]), words });
    }
    result.lines.sort((a, b) => a.start_time_ms - b.start_time_ms);
    result.sync_type = result.lines.some(l => l.words.length) ? 'word' : 'line';
    if (translation) mergeTranslation(result.lines, translation, source);
    return result;
  }
  /* Placeholder lyrics (credits only, "纯音乐，请欣赏") are not lyrics. */
  function finalizeLyrics(lyrics, note) {
    const texts = lyrics.lines.map(l => l.text.trim()).filter(Boolean);
    if (!note && texts.length && texts.every(t => CREDIT_LINE.test(t))) note = 'credits';
    if (!note && texts.length && texts.length <= 3 && texts.some(t => INSTRUMENTAL.test(t))) note = 'instrumental';
    if (note) { lyrics.lines = []; lyrics.note = note; }
    return lyrics;
  }
  function lyricsFromResponse(provider, raw) {
    if (provider === 'qq') {
      if (int(raw, 'req_1/code') === 24001 || int(raw, 'code') === -1901) return finalizeLyrics(emptyLyrics('qq'), 'missing');
      if (!at(raw, 'req_1') && typeof at(raw, 'lyric') === 'string') return finalizeLyrics(parseLrc(decodeLyric(str(raw, 'lyric')), decodeLyric(str(raw, 'trans')), 'qq'));
      return finalizeLyrics(parseLrc(decodeLyric(str(raw, 'req_1/data/lyric')), decodeLyric(str(raw, 'req_1/data/trans')), 'qq'));
    }
    if (at(raw, 'uncollected') === true) return finalizeLyrics(emptyLyrics('netease'), 'uncollected');
    if (at(raw, 'nolyric') === true) return finalizeLyrics(emptyLyrics('netease'), 'instrumental');
    const lrc = dropJsonLines(str(raw, 'lrc/lyric')), tlyric = dropJsonLines(str(raw, 'tlyric/lyric'));
    const yrc = dropJsonLines(str(raw, 'yrc/lyric'));
    let lyrics = yrc.trim() ? parseYrc(yrc, dropJsonLines(str(raw, 'ytlrc/lyric')) || tlyric, 'netease') : null;
    if (!lyricsUsable(lyrics)) lyrics = parseLrc(lrc, tlyric, 'netease');
    /* v1 sends credits as JSON lines; if nothing else remains it is a credits-only placeholder. */
    const creditsOnly = !lyricsUsable(lyrics) && /^\s*\{/m.test(str(raw, 'lrc/lyric') + str(raw, 'yrc/lyric'));
    return finalizeLyrics(lyrics, creditsOnly ? 'credits' : undefined);
  }

  /* -------------------------------------------------------- requests ---- */
  /* Mirrors sl_http_request: budget, cooldown after 429, transient retries. */
  class Http {
    constructor(transport) {
      this.transport = transport; this.cooldown = new Map(); this.inflight = new Map();
      this.stats = { requests: 0, sent_bytes: 0, received_bytes: 0, cache_hits: 0 };
    }
    cacheHit() { this.stats.cache_hits++; }
    async request(provider, req, { signal, budget, retries = 0 } = {}) {
      retries = Math.min(retries, 2);
      /* Identical concurrent requests share one network round-trip. */
      const key = `${req.method} ${req.url} ${req.body || ''}`;
      if (this.inflight.has(key)) return this.inflight.get(key);
      const promise = this._request(provider, req, signal, budget, retries).finally(() => this.inflight.delete(key));
      this.inflight.set(key, promise);
      return promise;
    }
    async _request(provider, req, signal, budget, retries) {
      for (let attempt = 1; ; attempt++) {
        if (signal && signal.aborted) throw new ProviderError('请求已取消', 'cancelled');
        const until = this.cooldown.get(provider);
        if (until && until > Date.now()) throw new ProviderError('来源正在限流冷却，请稍后重试', 'blocked');
        if (budget && budget.remaining <= 0) throw new ProviderError('本次请求预算已用完', 'blocked');
        if (budget) budget.remaining--;
        this.stats.requests++;
        this.stats.sent_bytes += req.url.length + (req.body ? req.body.length : 0) + 200;
        let response, error = null;
        try { response = await this.transport(req, signal); } catch (e) { error = e; }
        if (signal && signal.aborted) throw new ProviderError('请求已取消', 'cancelled');
        const status = response ? response.status : 0;
        if (response) this.stats.received_bytes += (response.body || '').length + 200;
        if (status === 429) {
          const header = response.retryAfter;
          let delay = 60;
          if (header && /^\d/.test(header)) delay = parseInt(header, 10);
          else if (header) { const date = Date.parse(header); if (!isNaN(date)) delay = (date - Date.now()) / 1000; }
          this.cooldown.set(provider, Date.now() + Math.max(delay, 1) * 1000);
          throw new ProviderError(`${PROVIDER_NAMES[provider] || provider}：请求过多，已进入冷却`, 'http');
        }
        const transient = status === 502 || status === 503 || status === 504 || (error && error.transient);
        if (transient && attempt <= retries && !(budget && budget.remaining <= 0)) {
          await new Promise(r => setTimeout(r, 500 << Math.min(attempt, 3)));
          continue;
        }
        if (error) throw error instanceof ProviderError ? error : new ProviderError(String(error.message || error), error.kind || 'network');
        if (response.body && response.body.length > MAX_RESPONSE) throw new ProviderError('响应超过 2 MiB 限制');
        return response;
      }
    }
  }

  /* --------------------------------------------------------- engine ----- */
  const CANCELLED = Symbol('cancelled');
  /* Shared bindings fetched from the lyrics server are cached locally for a while. */
  const CLOUD_CACHE = 'cloud1:', CLOUD_TTL = 1800, CLOUD_MISS_TTL = 600;
  const trackPayload = t => ({ uri: t.uri || '', title: t.title || '', artists: (t.artists || []).slice(0, 20), album: t.album || '', duration_ms: t.duration_ms || 0 });

  /* Runs entirely on the client: NetEase / QQ requests go through deps.http (direct, or
   * relayed by the lyrics server / local service when the renderer may not reach them);
   * the lyrics server (deps.cloud) only stores matches and lyrics that users chose or
   * uploaded. Without deps.cloud (pure local mode) everything stays on this machine. */
  class Engine {
    /**
     * deps: { store, http: Http, cloud?: Cloud, settings(): {preferred_provider, spotify_first, verify_lyrics},
     *         spotify?(track, signal) -> Promise<{lyrics, colors}|null|undefined>, onChange?() }
     */
    constructor(deps) {
      this.deps = deps; this.store = deps.store; this.http = deps.http; this.cloud = deps.cloud || null;
      this.track = null; this.lyrics = null; this.colors = null; this.status = '等待播放器';
      /* Where the current lyrics come from: the provider song (null for Spotify / local files)
       * and how it was chosen: local | cloud | manual | auto | verified | spotify. */
      this.match = null; this.origin = null; this.cloudError = '';
      this.generation = 0; this.controller = null; this.busy = false;
    }
    _changed() { try { this.deps.onChange && this.deps.onChange(); } catch (e) { console.error('[spot-lyric]', e); } }
    _setStatus(text) { this.status = text; this._changed(); }
    _install(lyrics, colors, match, origin) {
      this.lyrics = lyrics ? JSON.parse(JSON.stringify(lyrics)) : null;
      this.colors = colors || null;
      this.match = lyrics && match ? candidateFromJson(candidateJson(match)) : null;
      this.origin = lyrics ? origin || null : null;
      if (this.lyrics && this.track) { this.lyrics.track_uri = this.track.uri; this.lyrics.track_id = spotifyId(this.track.uri) || ''; }
    }
    _preferred() {
      const p = this.deps.settings().preferred_provider;
      return PROVIDERS.includes(p) ? p : 'netease';
    }
    offset() {
      if (!this.track) return 0;
      return (this.store.getInt('timing-offset-ms', 0)) + this.store.getInt('offset:' + trackKey(this.track), 0);
    }
    setOffset(value, global) {
      if (!global && !this.track) return;
      const key = global ? 'timing-offset-ms' : 'offset:' + trackKey(this.track);
      this.store.set(key, String(Math.max(-5000, Math.min(5000, Math.round(value)))));
      this._changed();
    }
    _interrupt() { if (this.controller) this.controller.abort(); this.generation++; this.busy = false; }
    async importLyrics(lyrics) {
      if (!lyricsUsable(lyrics) || !this.track) return;
      this._interrupt();
      await this.store.kvSet('local-lyrics:' + trackKey(this.track), JSON.stringify(lyrics));
      this._install(lyrics, null, null, 'local'); this._setStatus('已绑定本地歌词');
    }

    /* Provider search with cache, negative cooldown and budget (providers.c). */
    async providerSearch(provider, query, signal, budget) {
      const key = `search2:${provider}:${normalize(query)}`;
      const cached = await this._cached(key, provider);
      if (cached !== undefined) return cached.map(c => candidateFromJson(c)).filter(Boolean);
      try {
        const raw = await this._exchange(provider, searchRequest(provider, query), signal, budget, 2);
        const candidates = providerCandidates(provider, raw);
        await this.store.cachePut(key, JSON.stringify(candidates.map(candidateJson)), 86400);
        return candidates;
      } catch (e) { await this._failure(provider, e); throw e; }
    }
    async providerFetch(candidate, signal, budget) {
      const key = `${LYRICS_CACHE}:${candidate.provider}:${candidate.id}`;
      const cached = await this._cached(key, candidate.provider);
      if (cached !== undefined) return cached;
      try {
        const requests = fetchRequests(candidate);
        let raw;
        for (let i = 0; ; i++) {
          try { raw = await this._exchange(candidate.provider, requests[i], signal, budget, 1); break; }
          catch (e) { if (i + 1 >= requests.length || e.kind === 'cancelled' || e.kind === 'blocked') throw e; }
        }
        let lyrics;
        if (raw === null) {
          lyrics = parseLrc('', null, candidate.provider);
          await this.store.cachePut(key, JSON.stringify(lyrics), 21600);
          return lyrics;
        }
        lyrics = lyricsFromResponse(candidate.provider, raw);
        await this.store.cachePut(key, JSON.stringify(lyrics), lyricsUsable(lyrics) ? 0 : 21600);
        return lyrics;
      } catch (e) { await this._failure(candidate.provider, e); throw e; }
    }
    /* One request + parse; a transient service code is retried once. null = HTTP 404. */
    async _exchange(provider, request, signal, budget, retries) {
      for (let attempt = 0; ; attempt++) {
        const response = await this.http.request(provider, request, { signal, budget, retries });
        if (response.status === 404) return null;
        if (response.status >= 400) throw new ProviderError(`${PROVIDER_NAMES[provider]}：HTTP ${response.status}`, 'http');
        try { return parseProviderBody(provider, response.body); }
        catch (e) {
          if (e.kind !== 'transient' || attempt > 0 || (budget && budget.remaining <= 0)) throw e;
          await new Promise(r => setTimeout(r, 1200));
          if (signal && signal.aborted) throw new ProviderError('请求已取消', 'cancelled');
        }
      }
    }
    async _cached(key, provider) {
      const cached = await this.store.cacheGet(key);
      if (cached != null) { this.http.cacheHit(); return JSON.parse(cached); }
      if (await this.store.cacheGet('failure:' + provider) != null) throw new ProviderError('来源暂不可用，稍后自动重试', 'blocked');
      return undefined;
    }
    async _failure(provider, error) {
      if (error && (error.kind === 'cancelled' || error.kind === 'blocked')) return;
      await this.store.cachePut('failure:' + provider, '1', 60);
    }

    /* Automatic matching for the playing track (engine.c: sl_engine_track). */
    async setTrack(track, force = false) {
      if (!force && trackEqual(this.track, track)) return;
      if (this.controller) this.controller.abort();
      const generation = ++this.generation;
      this.track = track ? JSON.parse(JSON.stringify(track)) : null;
      this._install(null);
      if (!track || !track.title) { this._setStatus('等待播放器'); return; }
      const controller = this.controller = new AbortController();
      const current = () => generation === this.generation && !controller.signal.aborted;
      this.busy = true;
      try { await this._match(track, force, controller.signal, current); }
      catch (e) { if (e !== CANCELLED && current()) { console.error('[spot-lyric]', e); this._setStatus('匹配出错：' + (e.message || e)); } }
      finally { if (current()) { this.busy = false; this._changed(); } }
    }
    async _match(track, force, signal, current) {
      const check = () => { if (!current()) throw CANCELLED; };
      const key = trackKey(track);
      const local = await this.store.kvGet('local-lyrics:' + key); check();
      if (local && !force) {
        const lyrics = JSON.parse(local);
        if (lyricsUsable(lyrics)) { this._install(lyrics, null, null, 'local'); this.http.cacheHit(); this._setStatus('本地歌词'); return; }
      }
      /* Lyrics chosen or uploaded by a user and shared through the lyrics server
       * ("重新自动匹配" deliberately skips them). */
      if (!force && this.cloud && spotifyId(track.uri)) {
        const doc = await this._cloudGet(track, signal); check();
        if (doc) {
          const lyrics = await this._cloudLyrics(track, doc, signal); check();
          const name = PROVIDER_NAMES[(doc.match && doc.match.provider) || doc.source] || '';
          this._install(lyrics, null, candidateFromJson(doc.match), 'cloud');
          this._setStatus(`云端歌词${name ? ' · ' + name : ''}`); return;
        }
      }
      let { candidate: saved, manual } = await this.store.matchGet(track); check();
      if (saved && !manual) { const verified = saved.verified; matchScore(track, saved); if (!saved.eligible && !verified) saved = null; }
      const lyricsKey = TRACK_CACHE + key, negativeKey = NEGATIVE + key;
      if (!force) {
        const cached = await this.store.cacheGet(lyricsKey); check();
        if (cached) {
          const entry = JSON.parse(cached);
          if (lyricsUsable(entry.lyrics) && (saved || entry.lyrics.source === 'spotify')) {
            this._install(entry.lyrics, entry.colors, entry.match && candidateFromJson(entry.match), entry.origin || (manual ? 'manual' : 'auto'));
            this.http.cacheHit();
            this._setStatus(manual ? '已绑定歌词 · 缓存' : '歌词缓存'); return;
          }
        }
        const negative = await this.store.cacheGet(negativeKey); check();
        if (negative) { this.http.cacheHit(); this._setStatus(negative); return; }
      } else {
        await this.store.cacheRemove(lyricsKey); await this.store.cacheRemove(negativeKey);
        if (saved) await this.store.cacheRemove(`${LYRICS_CACHE}:${saved.provider}:${saved.id}`);
        check();
      }
      const job = {
        track, key, preferred: this._preferred(), candidates: [], fetched: new Set(), failed: false,
        searches: { remaining: 6 }, lyricsBudget: { remaining: 3 }, signal, check,
      };
      this._setStatus('正在匹配歌词');
      const settings = this.deps.settings();
      if (settings.spotify_first && !saved) {
        const result = await this._spotify(job);
        if (result && lyricsUsable(result.lyrics)) return this._complete(job, result.lyrics, 'Spotify 歌词', result.colors, null, 'spotify');
        job.spotifyTried = result !== undefined;
      }
      if (saved) {
        job.candidates.push(saved); job.fetched.add(`${saved.provider}:${saved.id}`);
        if (await this._tryCandidate(job, saved, manual)) return;
      }
      for (const query of searchQueries(track)) {
        if (job.searches.remaining <= 0) break;
        /* The title-only query is a last resort (LDDC): it only runs when nothing eligible turned up. */
        if (query.titleOnly && job.candidates.some(c => c.eligible)) break;
        /* Both sources are searched together; the preferred one wins near-ties (matchSelect). */
        await Promise.all(PROVIDERS.map(provider => this._search(job, provider, query.text)));
        check();
        while (await this._fetchBest(job)) { /* next eligible candidate when one has no lyrics */ }
        if (job.done) return;
      }
      /* Spotify's own lyrics are the fallback after both external sources. */
      if (!job.spotifyTried) {
        const result = await this._spotify(job);
        if (result !== undefined) {
          if (result && lyricsUsable(result.lyrics)) {
            if (this.deps.settings().verify_lyrics !== false && await this._verifyByLyrics(job, result)) return;
            return this._complete(job, result.lyrics, 'Spotify 歌词', result.colors, null, 'spotify');
          }
          return this._complete(job, null, job.failed ? '请求失败，可手动重试' : '未匹配，可手动选择歌词');
        }
      }
      return this._complete(job, null, job.failed ? '来源暂不可用，60 秒后可重试' : '未匹配，可手动选择歌词');
    }
    async _search(job, provider, query) {
      let result = [];
      try { result = await this.providerSearch(provider, query, job.signal, job.searches); }
      catch (e) { if (e.kind === 'cancelled') throw CANCELLED; if (e.kind !== 'blocked' || !/预算/.test(e.message)) job.failed = true; }
      for (const candidate of result) {
        if (job.candidates.some(o => o.provider === candidate.provider && o.id === candidate.id)) continue;
        job.candidates.push(matchScore(job.track, candidate));
      }
    }
    /* undefined: Spotify lyrics not applicable (no id / no lyrics flag); null: miss. */
    async _spotify(job) {
      if (!this.deps.spotify || !spotifyId(job.track.uri)) return undefined;
      try { const r = await this.deps.spotify(job.track, job.signal); job.check(); return r; }
      catch (e) { if (e === CANCELLED || job.signal.aborted) throw CANCELLED; if (e.kind !== 'denied') job.failed = true; return null; }
    }
    _verifyPool(job) {
      const flags = versionFlags(job.track.title), main = (job.track.artists || [])[0];
      const pool = job.candidates.filter(c => !job.fetched.has(`${c.provider}:${c.id}`) && c.delta_ms >= 0 &&
        c.delta_ms <= DURATION_TOLERANCE && versionFlags(c.title) === flags &&
        (c.artist_score >= 0.75 || (scriptsDiffer(main, (c.artists || [])[0]) && (c.title_score >= 0.5 || scriptsDiffer(job.track.title, c.title)))));
      return matchSort(pool, job.preferred);
    }
    /* Metadata could not decide (romaji vs kanji titles, "Eason Chan" vs 「陈奕迅」).
     * If Spotify has the lyrics, accept a same-length (±3 s), same-version candidate
     * only when its lyric text matches Spotify's. Keeps translations / word timing. */
    async _verifyByLyrics(job, spotify) {
      const pool = this._verifyPool(job);
      const budget = { remaining: 3 };
      for (const candidate of pool.slice(0, 3)) {
        job.fetched.add(`${candidate.provider}:${candidate.id}`);
        let lyrics = null;
        try { lyrics = await this.providerFetch(candidate, job.signal, budget); }
        catch (e) { if (e.kind === 'cancelled') throw CANCELLED; continue; }
        job.check();
        if (!lyricsUsable(lyrics)) continue;
        const similarity = lyricsSimilarity(spotify.lyrics, lyrics);
        if (similarity < 0.6) continue;
        candidate.verified = true;
        await this.store.matchSave(job.track, candidate, false);
        await this._complete(job, lyrics, `已匹配歌词 · ${PROVIDER_NAMES[candidate.provider]}（歌词比对 ${Math.round(similarity * 100)}%）`, spotify.colors, candidate, 'verified');
        return true;
      }
      return false;
    }
    async _fetchBest(job) {
      if (job.done || job.lyricsBudget.remaining <= 0) return false;
      const best = matchSelect(job.candidates.filter(c => !job.fetched.has(`${c.provider}:${c.id}`)), job.preferred);
      if (!best) return false;
      job.fetched.add(`${best.provider}:${best.id}`);
      return !(await this._tryCandidate(job, best, false)) && !job.done;
    }
    async _tryCandidate(job, candidate, manual) {
      let lyrics = null;
      try { lyrics = await this.providerFetch(candidate, job.signal, job.lyricsBudget); }
      catch (e) { if (e.kind === 'cancelled') throw CANCELLED; job.failed = true; }
      job.check();
      /* An eligible match that the source marks as instrumental is a final answer (LDDC). */
      if (lyrics && lyrics.note === 'instrumental' && !manual) { await this._complete(job, null, '纯音乐，没有歌词'); return true; }
      if (!lyricsUsable(lyrics)) return false;
      await this.store.matchSave(job.track, candidate, manual);
      await this._complete(job, lyrics, `${manual ? '已绑定' : '已匹配'}歌词 · ${PROVIDER_NAMES[candidate.provider]}`, null, candidate, manual ? 'manual' : 'auto');
      return true;
    }
    async _complete(job, lyrics, status, colors, match, origin) {
      job.check(); job.done = true;
      this._install(lyrics, colors, match, origin);
      if (lyricsUsable(lyrics)) {
        const entry = { lyrics, colors: colors || null, match: match ? candidateJson(match) : null, origin: origin || null };
        await this.store.cachePut(TRACK_CACHE + job.key, JSON.stringify(entry), 0);
        await this.store.cacheRemove(NEGATIVE + job.key);
      } else {
        await this.store.cachePut(NEGATIVE + job.key, status, job.failed ? 60 : 21600);
      }
      job.check();
      this._setStatus(status);
    }

    /* -------------------------------------------------- lyrics server ---- */
    async _cloudGet(track, signal) {
      const id = spotifyId(track.uri), key = CLOUD_CACHE + id;
      const cached = await this.store.cacheGet(key);
      if (cached != null) {
        this.http.cacheHit();
        const doc = JSON.parse(cached);
        return doc && lyricsUsable(doc.lyrics) ? doc : null;
      }
      let doc = null;
      try { doc = await this.cloud.get(id, signal); this.cloudError = ''; }
      catch (e) { if (e.kind === 'cancelled' || (signal && signal.aborted)) throw CANCELLED; this.cloudError = e.message || String(e); return null; }
      const usable = !!(doc && lyricsUsable(doc.lyrics));
      await this.store.cachePut(key, JSON.stringify(usable ? doc : null), usable ? CLOUD_TTL : CLOUD_MISS_TTL);
      return usable ? doc : null;
    }
    /* Lyrics stored by an older parser (e.g. misplaced translations) are re-fetched
     * from the bound source on this machine and the server copy is refreshed. */
    async _cloudLyrics(track, doc, signal) {
      const match = candidateFromJson(doc.match);
      if (!match || doc.lyrics.parser === PARSER_VERSION) return doc.lyrics;
      try {
        const fresh = await this.providerFetch(match, signal, { remaining: 2 });
        if (!lyricsUsable(fresh)) return doc.lyrics;
        this._upload(track, match, fresh).catch(() => {});
        return fresh;
      } catch (e) { if (e.kind === 'cancelled') throw CANCELLED; return doc.lyrics; }
    }
    /** local: not a Spotify track; offline: pure local mode (no lyrics server).
     * @returns {Promise<{stored?: string, updated_at?: string, local?: boolean, offline?: boolean, error?: string}>} */
    async _upload(track, candidate, lyrics) {
      const id = spotifyId(track.uri);
      if (!id) return { local: true };
      if (!this.cloud) return { offline: true };
      try {
        const answer = await this.cloud.put(trackPayload(track), candidate, lyrics);
        await this.store.cachePut(CLOUD_CACHE + id, JSON.stringify(answer.binding || null), CLOUD_TTL);
        return { stored: answer.stored || 'server', updated_at: answer.updated_at || '' };
      } catch (e) { return { error: e.message || String(e) }; }
    }
    /* Uploads the lyrics on screen (with the provider song they came from, if any). */
    async upload() {
      const track = this.track, lyrics = this.lyrics;
      if (!track || !lyricsUsable(lyrics)) throw new ProviderError('当前没有可上传的歌词', 'failed');
      if (lyrics.source === 'spotify') throw new ProviderError('Spotify 官方歌词受版权保护，不上传到服务器', 'denied');
      if (!spotifyId(track.uri)) throw new ProviderError('本地文件没有 Spotify 曲目 ID，无法上传', 'denied');
      if (!this.cloud) throw new ProviderError('纯本地模式不连接歌词服务器', 'denied');
      const result = await this._upload(track, this.match, lyrics);
      if (result.error) throw new ProviderError(result.error, 'failed');
      if (this.track === track) { this.origin = 'cloud'; this._changed(); }
      return result;
    }

    /* Manual search always queries both providers so the panel can show one
     * page per source, including the ones that failed or returned nothing. */
    async search(query) {
      const groups = PROVIDERS.map(provider => ({ provider, searched: false, error: null, candidates: [] }));
      const all = [];
      const track = this.track || { title: '', artists: [], album: '', duration_ms: 0 };
      const budget = { remaining: 6 };
      if (query && query.length <= 2048) {
        await Promise.all(PROVIDERS.map(async (provider, stage) => {
          if ((query.includes('y.qq.com/') && stage === 0) || (query.includes('music.163.com/') && stage === 1)) return;
          groups[stage].searched = true;
          try {
            for (const candidate of await this.providerSearch(provider, query, null, budget)) all.push(matchScore(track, candidate));
          } catch (e) { groups[stage].error = e.message || String(e); }
        }));
      }
      const preferred = this._preferred();
      matchSort(all, preferred);
      const automatic = matchSelect(all, preferred);
      const { candidate: saved, manual } = this.track ? await this.store.matchGet(this.track) : { candidate: null, manual: false };
      const bound = this.origin === 'cloud' && this.match ? this.match : manual ? saved : null;
      for (const candidate of all) {
        candidate.auto_selected = candidate === automatic;
        const same = (c) => !!(c && c.provider === candidate.provider && c.id === candidate.id);
        candidate.bound = same(bound);
        candidate.verified = !candidate.bound && same(saved) && !manual && !!saved.verified;
        groups[PROVIDERS.indexOf(candidate.provider)].candidates.push(candidate);
      }
      return { candidates: all, providers: groups };
    }
    preview(candidate) { return this.providerFetch(candidate, null, { remaining: 2 }); }
    /* "使用此歌词": bound on this machine and shared through the lyrics server. */
    async bind(candidate, lyrics) {
      if (!lyricsUsable(lyrics) || !this.track) return null;
      this._interrupt();
      const track = this.track, key = trackKey(track);
      await this.store.matchSave(track, candidate, true);
      await this.store.kvSet('local-lyrics:' + key, '');
      await this.store.cacheRemove(NEGATIVE + key);
      await this.store.cachePut(TRACK_CACHE + key, JSON.stringify({ lyrics, colors: null, match: candidateJson(candidate), origin: 'manual' }), 0);
      this._install(lyrics, null, candidate, 'manual'); this._setStatus(`已绑定歌词 · ${PROVIDER_NAMES[candidate.provider]}`);
      const result = await this._upload(track, candidate, lyrics);
      if (result.stored && this.track === track) { this.origin = 'cloud'; this._changed(); }
      return result;
    }
    /* Drops the binding here and on the lyrics server, local lyrics and caches, then rematches. */
    async unbind() {
      if (!this.track) return;
      const track = this.track, id = spotifyId(track.uri);
      let error = null;
      await this.store.matchRemove(track);
      await this.store.kvSet('local-lyrics:' + trackKey(track), '');
      if (this.cloud && id) {
        try { await this.cloud.remove(trackPayload(track)); } catch (e) { error = e; }
        await this.store.cacheRemove(CLOUD_CACHE + id);
      }
      await this.setTrack(track, true);
      if (error) throw error;
    }
  }

  /* ----------------------------------------------------- lyrics server ---- */
  /* Client of the lyrics server (server/): it stores shared matches + lyrics and,
   * when the Spotify renderer cannot reach NetEase / QQ itself (CORS), relays the
   * provider requests built here. All matching logic stays on the client. */
  class Cloud {
    /** transport(method, path, body: string|null, signal) -> Promise<{status, body: string}> */
    constructor(transport) {
      this.transport = transport;
      this.stats = { requests: 0, sent_bytes: 0, received_bytes: 0 };
    }
    async call(method, path, payload, signal, allowMissing) {
      const body = payload == null ? null : JSON.stringify(payload);
      this.stats.requests++;
      this.stats.sent_bytes += path.length + (body ? body.length : 0) + 200;
      let response;
      try { response = await this.transport(method, path, body, signal); }
      catch (e) {
        if (signal && signal.aborted) throw new ProviderError('请求已取消', 'cancelled');
        throw e instanceof ProviderError ? e : new ProviderError('无法连接歌词服务器', 'network');
      }
      this.stats.received_bytes += (response.body || '').length + 200;
      if (allowMissing && response.status === 404) return null;
      let data = null;
      try { data = JSON.parse(response.body); } catch (_) { /* below */ }
      if (response.status !== 200 || !data || typeof data !== 'object') {
        const message = data && data.error ? data.error : `歌词服务器错误 ${response.status}`;
        throw new ProviderError(message, response.status === 429 ? 'blocked' : response.status >= 500 || !response.status ? 'network' : 'failed');
      }
      return data;
    }
    async get(id, signal) { const answer = await this.call('GET', `/api/bindings/${encodeURIComponent(id)}`, null, signal, true); return answer ? answer.binding || null : null; }
    put(track, candidate, lyrics) {
      const clean = sanitizeLyrics(lyrics);
      if (!clean) return Promise.reject(new ProviderError('歌词为空', 'failed'));
      return this.call('POST', '/api/bind', { track, candidate: candidate ? candidateJson(candidate) : null, lyrics: clean });
    }
    remove(track) { return this.call('POST', '/api/unbind', { track }); }
    /* Same contract as an Http transport: resolves {status, body, retryAfter}. */
    async relay(req, signal) {
      const answer = await this.call('POST', '/api/relay', { method: req.method, url: req.url, headers: req.headers || {}, body: req.body == null ? null : String(req.body) }, signal);
      return { status: answer.status | 0, body: typeof answer.body === 'string' ? answer.body : '', retryAfter: answer.retry_after || null };
    }
  }

  /* Lyrics received from a client (upload / "使用此歌词"): bounded and stripped to
   * the known shape. Returns null when nothing usable remains. */
  const LYRIC_SOURCES = ['netease', 'qq', 'local', 'spotify'];
  function sanitizeLyrics(input) {
    if (!input || typeof input !== 'object' || !Array.isArray(input.lines)) return null;
    const time = v => Number.isFinite(v) ? Math.max(-3600000, Math.min(86400000, Math.trunc(v))) : 0;
    const text = (v, max) => typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max) : '';
    const sync = ['word', 'line', 'unsynced'].includes(input.sync_type) ? input.sync_type : 'line';
    const source = LYRIC_SOURCES.includes(input.source) ? input.source : 'local';
    const result = { source, provider: source, sync_type: sync, parser: Number.isInteger(input.parser) ? input.parser : 0, lines: [] };
    for (const line of input.lines.slice(0, 5000)) {
      if (!line || typeof line !== 'object') continue;
      const start = time(line.start_time_ms);
      const out = { text: text(line.text, 500), start_time_ms: start, end_time_ms: Math.max(start, time(line.end_time_ms)), words: [] };
      const translated = text(line.translated_text, 500);
      if (translated) out.translated_text = translated;
      if (sync === 'word' && Array.isArray(line.words)) {
        for (const word of line.words.slice(0, 400)) {
          const wordText = word && typeof word === 'object' ? text(word.text, 200) : '';
          if (!wordText) continue;
          const ws = time(word.start_time_ms);
          out.words.push({ text: wordText, start_time_ms: ws, end_time_ms: Math.max(ws, time(word.end_time_ms)) });
        }
      }
      result.lines.push(out);
    }
    result.lines.sort((a, b) => a.start_time_ms - b.start_time_ms);
    return lyricsUsable(result) ? result : null;
  }

  const api = {
    DURATION_TOLERANCE, PROVIDERS, PROVIDER_NAMES, normalize, toSimplified, textSimilarity, versionFlags, titleBase, titleCore, titleSimilarity,
    artistSimilarity, artistNames, durationDelta, durationScore, matchScore, matchSort, matchSelect, searchQueries, scriptsDiffer,
    trackKey, spotifyId, trackEqual, trackPayload, romanize, lyricsSimilarity,
    candidateFromJson, candidateJson, parseLrc, spotifyLyrics, lyricsUsable, lyricsIndex, exportLrc, sanitizeLyrics,
    providerCandidates, searchRequest, fetchRequest, fetchRequests, parseProviderBody, lyricsFromResponse, decodeLyric,
    parseYrc, finalizeLyrics, emptyLyrics, PARSER_VERSION,
    ProviderError, Http, Engine, Cloud,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SpotLyricCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
