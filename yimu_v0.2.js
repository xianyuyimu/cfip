/*!
 * @name 一木聚合
 * @description 极致高音质调度策略：母带/全景声/Hi-Res最高音质优先秒播，精准ID直出，5秒智能降级兜底
 * @version 0.2
 * @author 一木
 */

const { EVENT_NAMES, request, on, send, utils, env, version, currentScriptInfo } = globalThis.lx;

// =============================================================================
// 1. 全局策略配置
// =============================================================================
const CONFIG = {
  deadline: 5000,       // 全局硬熔断：5秒
  autoFallback: true,   // 严格按"最高档位优先、降级最后"的顺序执行
  kg320kUpgradeToLossless: true,
};

// 逐后端独立超时预算（毫秒）
const TIMEOUT = {
  '云萌阁酷我(母带/无损)': 4500,
  '酷我官方mobi签名': 4000,
  'HelloWorld酷我(全音质)': 4000,
  '酷我官方antiserver(128k)': 1500,
  'ikun网易云(全音质)': 4500,
  '残像API(实测无损)': 4500,
  '溯音163(官方直出)': 2000,
  '巡回寺QQ(MID直出)': 4500,
  'HelloWorld QQ': 4000,
  'HelloWorld酷狗(全音质)': 4500,
  '念心酷狗': 4000,
  '酷狗全网解析兜底': 4500,
  '星海主后端': 4500,
};

// =============================================================================
// 2. 音质定义表（与洛雪App预加载白名单精确一致）
// =============================================================================
const MUSIC_QUALITY = {
  kw: ['128k', '192k', '320k', 'flac', 'hires', 'atmos', 'atmos_plus', 'master'],
  kg: ['128k', '320k', 'flac', 'hires', 'atmos', 'master'],
  tx: ['128k', '320k', 'flac', 'hires', 'atmos', 'atmos_plus', 'master'],
  wy: ['128k', '320k', 'flac', 'hires', 'atmos', 'master'],
  mg: ['128k', '320k', 'flac', 'hires'],
};

const MUSIC_SOURCE = Object.keys(MUSIC_QUALITY);

// =============================================================================
// 3. 网络工具层
// =============================================================================
const NetHelper = {
  http: (url, options = {}, timeoutMs = CONFIG.deadline) => new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        reject(new Error(`请求超时(${timeoutMs}ms)`));
      }
    }, timeoutMs);

    request(url, { method: 'GET', ...options }, (err, resp) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (err) return reject(err);
      let data = resp ? resp.body : '';
      if (typeof data === 'string') {
        const s = data.trim();
        if (s.startsWith('{') || s.startsWith('[')) {
          try { data = JSON.parse(s); } catch (_) {}
        }
      }
      resolve({ data, statusCode: resp ? resp.statusCode : 200 });
    });
  }),

  extractUrl: (obj, paths = []) => {
    if (!obj) return '';
    if (typeof obj === 'string') {
      const s = obj.trim();
      if (s.startsWith('http://') || s.startsWith('https://')) return s;
      if (s.startsWith('//')) return 'https:' + s;
    }
    for (const p of paths) {
      let cur = obj;
      for (const k of p.split('.')) {
        if (cur == null) break;
        cur = cur[k];
      }
      if (Array.isArray(cur)) cur = cur[0];
      if (typeof cur === 'string') {
        cur = cur.replace(/\\/g, '').trim();
        if (cur.startsWith('http://') || cur.startsWith('https://')) return cur;
        if (cur.startsWith('//')) return 'https:' + cur;
      }
    }
    return '';
  },

  b64Decode: (str) => {
    if (!str) return '';
    try {
      if (typeof atob !== 'undefined') return decodeURIComponent(escape(atob(str)));
    } catch (_) {}
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    let output = '';
    str = String(str).replace(/=+$/, '');
    for (let bc = 0, bs, buffer, idx = 0; buffer = str.charAt(idx++); ~buffer && (bs = bc % 4 ? bs * 64 + buffer : buffer, bc++ % 4) ? output += String.fromCharCode(255 & bs >> (-2 * bc & 6)) : 0) {
      buffer = chars.indexOf(buffer);
    }
    try { return decodeURIComponent(escape(output)); } catch (_) { return output; }
  }
};

// =============================================================================
// 4. 音质映射与降级阶梯
// =============================================================================
const QualityHelper = {
  toWyLevel: (q) => ({
    '128k': 'standard', '320k': 'exhigh', 'flac': 'lossless',
    'flac24bit': 'hires', 'hires': 'hires', 'atmos': 'sky', 'master': 'jymaster'
  }[q] || 'standard'),

  toKgLevel: (q) => {
    if (['flac', 'flac24bit', 'hires', 'atmos', 'master'].includes(q)) return 'lossless';
    if (q === '320k' && CONFIG.kg320kUpgradeToLossless) return 'lossless';
    return 'standard';
  },

  getFallbackList: (q) => {
    const list = ['master', 'atmos_plus', 'atmos', 'hires', 'flac24bit', 'flac', '320k', '192k', '128k'];
    const idx = list.indexOf(q);
    return idx >= 0 ? list.slice(idx) : [q, 'flac', '320k', '128k'];
  },

  getMusicId: (source, info) => {
    if (source === 'kg') return info.hash || info.id;
    if (source === 'kw') return String(info.rid || info.id || info.songmid || '').replace('MUSIC_', '');
    if (source === 'tx') return info.songmid || info.mid || info.id;
    return String(info.id || info.songmid || info.hash);
  }
};

// 酷我官方 mobi.s 动态签名
const getKuwoMobiLink = async (rid, bitrate, fmt) => {
  const user = Math.floor(Math.random() * 0xFFFFFFFF);
  let androidId = '';
  const hex = '0123456789abcdef';
  for (let i = 0; i < 16; i++) androidId += hex[Math.floor(Math.random() * 16)];

  const br = `${bitrate}k${fmt}`;
  const hosts = ['mobi.kuwo.cn', 'nmobi.kuwo.cn'];
  const host = hosts[Math.floor(Math.random() * hosts.length)];
  const url = `http://${host}/mobi.s?f=web&user=${user}&android_id=${androidId}&source=kwplayer_ar_5.1.0.0_B_jiakong_vh.apk&type=convert_url_with_sign&from=PC&rid=${rid}&br=${br}&format=${fmt}`;

  const res = await NetHelper.http(url, { headers: { 'User-Agent': 'okhttp/4.10.0', 'Referer': 'http://www.kuwo.cn/' } }, TIMEOUT['酷我官方mobi签名']);
  const data = res.data;
  if (data && data.code === 200 && data.data && data.data.url) {
    return data.data.url;
  }
  throw new Error(`${host}: 未获取到直链`);
};

// =============================================================================
// 5. 各平台后端接口注册表
// =============================================================================
const API_REGISTRY = {
  // ──────────────── 酷我音乐 (kw) ────────────────
  kw: [
    {
      name: '云萌阁酷我(母带/无损)',
      canServe: ['master', 'atmos', 'atmos_plus', 'hires', 'flac24bit', 'flac', '320k', '192k', '128k'],
      customHandler: async (songId, tier) => {
        const res = await NetHelper.http(`https://api.yunmge.com/api/song_kuwo?id=${songId}&type=${tier}&key=api-233253f5566ff0397b70af8b8135ae78256ae815&token=2982c594fb6974de941fe1a0534e0d06`, {}, TIMEOUT['云萌阁酷我(母带/无损)']);
        const list = res.data?.data?.all_bitrates;
        if (!Array.isArray(list) || !list.length) throw new Error('云萌阁: 无音质列表');

        const wantMap = {
          'master': ['hires', '4000'],
          'atmos': ['hires', '4000'],
          'atmos_plus': ['hires', '4000'],
          'hires': ['hires', '4000'],
          'flac24bit': ['4000', 'hires'],
          'flac': ['flac', '2000'],
          '320k': ['320'],
          '192k': ['192'],
          '128k': ['128']
        };
        const targets = wantMap[tier] || [tier];
        for (const t of targets) {
          const hit = list.find((item) => String(item.bitrate) === t && item.play_url);
          if (hit) return hit.play_url;
        }
        throw new Error(`云萌阁: 无对应 ${tier} 原盘`);
      }
    },
    {
      name: '酷我官方mobi签名',
      canServe: ['master', 'atmos', 'atmos_plus', 'hires', 'flac24bit', 'flac', '320k', '192k', '128k'],
      customHandler: async (songId, tier) => {
        const cleanId = String(songId).replace('MUSIC_', '');
        const map = {
          'master': [2000, 'flac'],
          'atmos': [2000, 'flac'],
          'hires': [2000, 'flac'],
          'flac24bit': [2000, 'flac'],
          'flac': [2000, 'flac'],
          '320k': [320, 'mp3'],
          '192k': [192, 'ogg'],
          '128k': [128, 'mp3']
        };
        const pair = map[tier] || [128, 'mp3'];
        return await getKuwoMobiLink(cleanId, pair[0], pair[1]);
      }
    },
    {
      name: 'HelloWorld酷我(全音质)',
      canServe: ['master', 'atmos', 'hires', 'flac24bit', 'flac', '320k', '128k'],
      customHandler: async (songId, tier) => {
        const res = await NetHelper.http('https://c.wwwweb.top/music/url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'lx-music-desktop/2.10.1' },
          body: JSON.stringify({ source: 'kw', musicId: songId, quality: tier }),
        }, TIMEOUT['HelloWorld酷我(全音质)']);
        const d = res.data;
        if (d && d.data && d.data.url) return d.data.url;
        if (d && d.url) return d.url;
        throw new Error('HelloWorld酷我: 无直链');
      }
    },
    {
      name: '酷我官方antiserver(128k)',
      canServe: ['128k'],
      customHandler: async (songId, tier) => {
        const pureRid = String(songId).replace('MUSIC_', '');
        const res = await NetHelper.http(`http://antiserver.kuwo.cn/anti.s?type=convert_url&rid=${pureRid}&format=mp3&response=url`, {}, TIMEOUT['酷我官方antiserver(128k)']);
        const url = (typeof res.data === 'string' ? res.data : '').trim();
        if (url && url.startsWith('http')) return url;
        throw new Error('antiserver: 无直链');
      }
    }
  ],

  // ──────────────── 网易云音乐 (wy) ────────────────
  wy: [
    {
      name: 'ikun网易云(全音质)',
      canServe: ['master', 'atmos', 'hires', 'flac24bit', 'flac', '320k', '128k'],
      customHandler: async (songId, tier) => {
        const res = await NetHelper.http('https://c.wwwweb.top/music/url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'lx-music-request/2.9.0' },
          body: JSON.stringify({ source: 'wy', musicId: songId, quality: tier }),
        }, TIMEOUT['ikun网易云(全音质)']);
        const d = res.data;
        if (d && d.data && d.data.url) return d.data.url;
        if (d && d.url) return d.url;
        throw new Error('ikun网易云: 获取失败');
      }
    },
    {
      name: '残像API(实测无损)',
      canServe: ['master', 'hires', 'flac24bit', 'flac', '320k'],
      customHandler: async (songId, tier) => {
        const res = await NetHelper.http(`https://api.cxzja.cn/api/wyymusic?id=${songId}&level=lossless&token=api-isgzr1qfmdw7ka`, {}, TIMEOUT['残像API(实测无损)']);
        const url = NetHelper.extractUrl(res.data, ['data.url', 'url']);
        if (url && url.startsWith('http')) return url;
        throw new Error('残像API: 无数据');
      }
    },
    {
      name: '溯音163(官方直出)',
      canServe: ['320k', '128k'],
      customHandler: async (songId, tier) => {
        const res = await NetHelper.http(`https://oiapi.net/api/Music_163?id=${songId}&level=${tier}`, {}, TIMEOUT['溯音163(官方直出)']);
        const url = NetHelper.extractUrl(res.data, ['data.0.url', 'data.url', 'url']);
        if (url && url.startsWith('http')) return url;
        throw new Error('溯音163: 无数据');
      }
    }
  ],

  // ──────────────── QQ 音乐 (tx) ────────────────
  tx: [
    {
      name: '巡回寺QQ(MID直出)',
      canServe: ['master', 'atmos', 'atmos_plus', 'hires', 'flac24bit', 'flac', '320k', '128k'],
      customHandler: async (songmid, tier) => {
        const res = await NetHelper.http(`https://api.xunhuisi.store/API/QQMusic/Song.php?mid=${songmid}`, {}, TIMEOUT['巡回寺QQ(MID直出)']);
        const d = res.data;
        if (d && (d.music_url || d.url)) return d.music_url || d.url;
        if (typeof d === 'string' && d.startsWith('http')) return d;
        throw new Error('巡回寺QQ: 无数据');
      }
    },
    {
      name: 'HelloWorld QQ',
      canServe: ['master', 'flac', '320k', '128k'],
      customHandler: async (songmid, tier, musicInfo) => {
        const typeMap = { '128k': 0, '320k': 1, 'flac': 4, 'master': 5 };
        const type = typeMap[tier] != null ? typeMap[tier] : 1;
        const searchKey = encodeURIComponent((musicInfo.name || '') + ' ' + (musicInfo.singer || ''));
        const res = await NetHelper.http(`https://a.aa.cab/qq.music?msg=${searchKey}&n=1&type=${type}`, {}, TIMEOUT['HelloWorld QQ']);
        const d = res.data;
        if (typeof d === 'string' && d.startsWith('http')) return d.trim();
        if (d && d.url) return d.url;
        if (d && d.data && d.data.url) return d.data.url;
        throw new Error('HelloWorld QQ: 无直链');
      }
    }
  ],

  // ──────────────── 酷狗音乐 (kg) ────────────────
  kg: [
    {
      name: 'HelloWorld酷狗(全音质)',
      canServe: ['master', 'atmos', 'hires', 'flac24bit', 'flac', '320k', '128k'],
      customHandler: async (hash, tier) => {
        const res = await NetHelper.http('https://c.wwwweb.top/music/url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'lx-music-request/2.9.0' },
          body: JSON.stringify({ source: 'kg', musicId: hash, quality: tier }),
        }, TIMEOUT['HelloWorld酷狗(全音质)']);
        const d = res.data;
        if (d && d.data && d.data.url) return d.data.url;
        if (d && d.url) return d.url;
        throw new Error('HelloWorld酷狗: 获取失败');
      }
    },
    {
      name: '念心酷狗',
      canServe: ['master', 'atmos', 'hires', 'flac24bit', 'flac', '320k', '128k'],
      customHandler: async (hash, tier) => {
        const lvl = ['flac', 'flac24bit', 'hires', 'atmos', 'master'].includes(tier) ? 'lossless' : 'standard';
        const res = await NetHelper.http(`https://mcp.nianxinxz.com/share/ceshi/kg.php?id=${hash}&level=${lvl}`, {}, TIMEOUT['念心酷狗']);
        const url = NetHelper.extractUrl(res.data, ['url', 'data.url']);
        if (url && url.startsWith('http') && url !== 'None') return url;
        throw new Error('念心酷狗: 无直链');
      }
    },
    {
      name: '酷狗全网解析兜底',
      canServe: ['master', 'atmos', 'hires', 'flac24bit', 'flac', '320k', '128k'],
      customHandler: async (hash, tier, musicInfo) => {
        if (!musicInfo || (!musicInfo.name && !musicInfo.songname)) throw new Error('缺少歌曲元数据');
        const searchKey = encodeURIComponent((musicInfo.name || musicInfo.songname) + ' ' + (musicInfo.singer || musicInfo.artist || ''));
        const res = await NetHelper.http(`https://api.xunhuisi.store/API/QQMusic/Song.php?mid=${searchKey}`, {}, TIMEOUT['酷狗全网解析兜底']);
        const d = res.data;
        if (d && (d.music_url || d.url)) return d.music_url || d.url;
        if (typeof d === 'string' && d.startsWith('http')) return d;
        throw new Error('酷狗全网解析兜底失败');
      }
    }
  ],

  // ──────────────── 咪咕音乐 (mg) ────────────────
  mg: [
    {
      name: '星海主后端',
      canServe: ['flac', '320k', '128k'],
      customHandler: async (songId, tier) => {
        const res = await NetHelper.http(`https://yy.zddyr.top/lx/api/?source=migu&songmid=${songId}&quality=${tier}`, {}, TIMEOUT['星海主后端']);
        const d = res.data;
        if (d && d.data && d.data.url) return d.data.url;
        if (d && d.url) return d.url;
        throw new Error('星海主后端: 获取失败');
      }
    }
  ]
};

// =============================================================================
// 6. 核心调度阶梯
// =============================================================================
const PLANS = {
  kw: {
    'master': [
      ['master', '云萌阁酷我(母带/无损)'],
      ['flac', '云萌阁酷我(母带/无损)', '酷我官方mobi签名', 'HelloWorld酷我(全音质)'],
      ['320k', '云萌阁酷我(母带/无损)', 'HelloWorld酷我(全音质)'],
      ['128k', '酷我官方antiserver(128k)', '云萌阁酷我(母带/无损)']
    ],
    'atmos': [
      ['atmos', '云萌阁酷我(母带/无损)'],
      ['flac', '云萌阁酷我(母带/无损)', '酷我官方mobi签名'],
      ['128k', '酷我官方antiserver(128k)']
    ],
    'atmos_plus': [
      ['atmos_plus', '云萌阁酷我(母带/无损)'],
      ['flac', '云萌阁酷我(母带/无损)'],
      ['128k', '酷我官方antiserver(128k)']
    ],
    'hires': [
      ['hires', '云萌阁酷我(母带/无损)'],
      ['flac', '云萌阁酷我(母带/无损)', '酷我官方mobi签名'],
      ['128k', '酷我官方antiserver(128k)']
    ],
    'flac24bit': [
      ['flac24bit', '云萌阁酷我(母带/无损)'],
      ['flac', '云萌阁酷我(母带/无损)', '酷我官方mobi签名'],
      ['128k', '酷我官方antiserver(128k)']
    ],
    'flac': [
      ['flac', '云萌阁酷我(母带/无损)', '酷我官方mobi签名', 'HelloWorld酷我(全音质)'],
      ['320k', '云萌阁酷我(母带/无损)', 'HelloWorld酷我(全音质)'],
      ['128k', '酷我官方antiserver(128k)']
    ],
    '320k': [
      ['320k', '云萌阁酷我(母带/无损)', 'HelloWorld酷我(全音质)', '酷我官方mobi签名'],
      ['128k', '酷我官方antiserver(128k)']
    ],
    '192k': [
      ['192k', '云萌阁酷我(母带/无损)', '酷我官方mobi签名'],
      ['128k', '酷我官方antiserver(128k)']
    ],
    '128k': [
      ['128k', '酷我官方antiserver(128k)', '云萌阁酷我(母带/无损)', '酷我官方mobi签名']
    ]
  },
  wy: {
    'master': [
      ['master', 'ikun网易云(全音质)', '残像API(实测无损)'],
      ['flac', 'ikun网易云(全音质)', '残像API(实测无损)'],
      ['320k', 'ikun网易云(全音质)', '溯音163(官方直出)'],
      ['128k', '溯音163(官方直出)']
    ],
    'atmos': [
      ['atmos', 'ikun网易云(全音质)'],
      ['flac', 'ikun网易云(全音质)'],
      ['128k', '溯音163(官方直出)']
    ],
    'hires': [
      ['hires', 'ikun网易云(全音质)', '残像API(实测无损)'],
      ['flac', 'ikun网易云(全音质)', '残像API(实测无损)'],
      ['128k', '溯音163(官方直出)']
    ],
    'flac24bit': [
      ['flac24bit', 'ikun网易云(全音质)', '残像API(实测无损)'],
      ['flac', 'ikun网易云(全音质)', '残像API(实测无损)'],
      ['128k', '溯音163(官方直出)']
    ],
    'flac': [
      ['flac', 'ikun网易云(全音质)', '残像API(实测无损)'],
      ['320k', 'ikun网易云(全音质)', '溯音163(官方直出)'],
      ['128k', '溯音163(官方直出)']
    ],
    '320k': [
      ['320k', 'ikun网易云(全音质)', '溯音163(官方直出)'],
      ['128k', '溯音163(官方直出)']
    ],
    '128k': [
      ['128k', 'ikun网易云(全音质)', '溯音163(官方直出)']
    ]
  },
  tx: {
    'master': [
      ['master', '巡回寺QQ(MID直出)', 'HelloWorld QQ'],
      ['flac', '巡回寺QQ(MID直出)', 'HelloWorld QQ'],
      ['320k', '巡回寺QQ(MID直出)'],
      ['128k', '巡回寺QQ(MID直出)']
    ],
    'atmos': [
      ['atmos', '巡回寺QQ(MID直出)'],
      ['flac', '巡回寺QQ(MID直出)'],
      ['128k', '巡回寺QQ(MID直出)']
    ],
    'atmos_plus': [
      ['atmos_plus', '巡回寺QQ(MID直出)'],
      ['flac', '巡回寺QQ(MID直出)'],
      ['128k', '巡回寺QQ(MID直出)']
    ],
    'hires': [
      ['hires', '巡回寺QQ(MID直出)'],
      ['flac', '巡回寺QQ(MID直出)'],
      ['128k', '巡回寺QQ(MID直出)']
    ],
    'flac24bit': [
      ['flac24bit', '巡回寺QQ(MID直出)'],
      ['flac', '巡回寺QQ(MID直出)'],
      ['128k', '巡回寺QQ(MID直出)']
    ],
    'flac': [
      ['flac', '巡回寺QQ(MID直出)', 'HelloWorld QQ'],
      ['320k', '巡回寺QQ(MID直出)'],
      ['128k', '巡回寺QQ(MID直出)']
    ],
    '320k': [
      ['320k', '巡回寺QQ(MID直出)', 'HelloWorld QQ'],
      ['128k', '巡回寺QQ(MID直出)']
    ],
    '128k': [
      ['128k', '巡回寺QQ(MID直出)', 'HelloWorld QQ']
    ]
  },
  kg: {
    'master': [
      ['master', 'HelloWorld酷狗(全音质)', '念心酷狗', '酷狗全网解析兜底'],
      ['flac', 'HelloWorld酷狗(全音质)', '念心酷狗', '酷狗全网解析兜底'],
      ['320k', 'HelloWorld酷狗(全音质)', '念心酷狗'],
      ['128k', 'HelloWorld酷狗(全音质)', '念心酷狗']
    ],
    'atmos': [
      ['atmos', 'HelloWorld酷狗(全音质)', '念心酷狗'],
      ['flac', 'HelloWorld酷狗(全音质)'],
      ['128k', 'HelloWorld酷狗(全音质)']
    ],
    'hires': [
      ['hires', 'HelloWorld酷狗(全音质)', '念心酷狗'],
      ['flac', 'HelloWorld酷狗(全音质)'],
      ['128k', 'HelloWorld酷狗(全音质)']
    ],
    'flac24bit': [
      ['flac24bit', 'HelloWorld酷狗(全音质)', '念心酷狗'],
      ['flac', 'HelloWorld酷狗(全音质)'],
      ['128k', 'HelloWorld酷狗(全音质)']
    ],
    'flac': [
      ['flac', 'HelloWorld酷狗(全音质)', '念心酷狗', '酷狗全网解析兜底'],
      ['320k', 'HelloWorld酷狗(全音质)', '念心酷狗'],
      ['128k', 'HelloWorld酷狗(全音质)', '念心酷狗']
    ],
    '320k': [
      ['320k', 'HelloWorld酷狗(全音质)', '念心酷狗'],
      ['128k', 'HelloWorld酷狗(全音质)', '念心酷狗']
    ],
    '128k': [
      ['128k', 'HelloWorld酷狗(全音质)', '念心酷狗']
    ]
  },
  mg: {
    'master': [['flac', '星海主后端'], ['320k', '星海主后端'], ['128k', '星海主后端']],
    'flac': [['flac', '星海主后端'], ['320k', '星海主后端'], ['128k', '星海主后端']],
    '320k': [['320k', '星海主后端'], ['128k', '星海主后端']],
    '128k': [['128k', '星海主后端']]
  }
};

const raceBatch = (tasks) => new Promise((resolve, reject) => {
  let failedCount = 0;
  const errors = [];
  if (tasks.length === 0) return reject(new Error('无待执行任务'));

  tasks.forEach(({ backend, exec }) => {
    exec()
      .then((url) => {
        if (url) resolve({ url, backend });
        else throw new Error('返回URL为空');
      })
      .catch((err) => {
        failedCount++;
        errors.push(`${backend.name}: ${err.message}`);
        if (failedCount === tasks.length) reject(new Error(errors.join(' | ')));
      });
  });
});

const handleGetMusicUrl = async (source, musicInfo, quality) => {
  const songId = QualityHelper.getMusicId(source, musicInfo);
  if (!songId) throw new Error('无法解析歌曲ID');

  const available = API_REGISTRY[source] || [];
  if (!available.length) throw new Error(`未配置 [${source}] 源`);

  let plan = (PLANS[source] || {})[quality];
  if (!plan) {
    plan = QualityHelper.getFallbackList(quality).map((q) => [q, ...available.map((b) => b.name)]);
  }

  const byName = Object.fromEntries(available.map((b) => [b.name, b]));
  const errors = [];
  const startedAt = Date.now();

  for (const [tier, ...names] of plan) {
    const backends = names.map((n) => byName[n]).filter((b) => b && b.canServe.includes(tier));
    if (!backends.length) continue;

    if (Date.now() - startedAt > CONFIG.deadline) {
      errors.push(`已达5秒硬熔断上限，停止降级`);
      break;
    }

    try {
      const winner = await raceBatch(backends.map((b) => ({
        backend: b,
        exec: () => b.customHandler(songId, tier, musicInfo)
      })));

      if (winner && winner.url) {
        return winner.url;
      }
    } catch (err) {
      errors.push(`[${tier}] ${err.message}`);
    }
  }

  throw new Error('所有音质档位及后端全部失败:\n' + errors.join('\n'));
};

// =============================================================================
// 7. 注册与初始化（严格遵守洛雪客户端App规范）
// =============================================================================
on(EVENT_NAMES.request, ({ action, source, info }) => {
  switch (action) {
    case 'musicUrl':
      return handleGetMusicUrl(source, info.musicInfo, info.type);
    default:
      return Promise.reject(new Error(`不支持的操作: ${action}`));
  }
});

send(EVENT_NAMES.inited, {
  status: true,
  openDevTools: false,
  sources: {
    kw: {
      name: '酷我音乐',
      type: 'music',
      actions: ['musicUrl'],
      qualitys: ['128k', '192k', '320k', 'flac', 'hires', 'atmos', 'atmos_plus', 'master']
    },
    kg: {
      name: '酷狗音乐',
      type: 'music',
      actions: ['musicUrl'],
      qualitys: ['128k', '320k', 'flac', 'hires', 'atmos', 'master']
    },
    tx: {
      name: 'QQ音乐',
      type: 'music',
      actions: ['musicUrl'],
      qualitys: ['128k', '320k', 'flac', 'hires', 'atmos', 'atmos_plus', 'master']
    },
    wy: {
      name: '网易云音乐',
      type: 'music',
      actions: ['musicUrl'],
      qualitys: ['128k', '320k', 'flac', 'hires', 'atmos', 'master']
    },
    mg: {
      name: '咪咕音乐',
      type: 'music',
      actions: ['musicUrl'],
      qualitys: ['128k', '320k', 'flac', 'hires']
    }
  }
});
