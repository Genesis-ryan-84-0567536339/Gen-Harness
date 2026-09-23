/**
 * Screen registry — docs/design/screens.json + the design's TITLES map and
 * screen-title descriptions (docs/design/Gen-Harness Console.dc.html).
 * The router, breadcrumbs and the static nav fallback are all generated
 * from this one tree (docs/handoff/04 "không khai báo hai nơi").
 * test/unit/screens.test.ts checks it against docs/design/screens.json.
 */

export type DomainId = 'business' | 'tech';

export interface ScreenMeta {
  key: string;
  domain: DomainId;
  /** Parent group name (null for level-1 screens). */
  parent: string | null;
  /** Nav label (screens.json `name`). */
  name: string;
  /** English nav subtitle (screens.json `en`), used in tooltips. */
  en: string;
  /** Header title (TITLES[0]). */
  title: string;
  /** Header English subtitle (TITLES[1]), shown for parent-level screens only. */
  subtitle: string;
  /** Screen-title row description (12.5px neutral-400) from the design. */
  description: string;
  /** Max width of the title block in the design (700 or 760). */
  descMaxWidth: 700 | 760;
  /**
   * Whether the design draws a screen-title row for this screen. overview,
   * workbench and profile have none in the design (the header carries the
   * title); phase 1 still shows one built from TITLES so every placeholder is
   * labelled.
   */
  designTitleRow: boolean;
  /** Phosphor icon class from the design NAV. */
  icon: string;
}

export interface DomainMeta {
  id: DomainId;
  label: string;
  crumb: string;
  icon: string;
}

export const DOMAINS: Record<DomainId, DomainMeta> = {
  business: { id: 'business', label: 'Kinh doanh', crumb: 'KINH DOANH', icon: 'ph-fill ph-briefcase' },
  tech: { id: 'tech', label: 'Kỹ thuật · Backend', crumb: 'KỸ THUẬT', icon: 'ph-fill ph-cpu' },
};

export const GROUP_ICONS: Record<string, string> = {
  'Hàng đợi & Hành động': 'ph ph-tray',
  'Bản đồ quan hệ': 'ph ph-graph',
  'Cơ hội & Thị trường': 'ph ph-target',
  'Con người & Chất lượng': 'ph ph-users-three',
  'Tầng dữ liệu': 'ph ph-database',
  'Agent & Model': 'ph ph-robot',
};

export const SCREENS: ScreenMeta[] = [
  {
    key: 'overview', domain: 'business', parent: null, icon: 'ph ph-gauge',
    name: 'Tổng quan điều hành', en: 'Command Overview — màn hình 10 phút',
    title: 'Tổng quan điều hành', subtitle: 'Command Overview · hôm nay có gì đang xảy ra',
    description: 'Command Overview · hôm nay có gì đang xảy ra', descMaxWidth: 700, designTitleRow: false,
  },
  {
    key: 'inbox', domain: 'business', parent: 'Hàng đợi & Hành động', icon: 'ph ph-tray',
    name: 'Hộp thư ý nghĩa', en: 'Inbox of Meaning',
    title: 'Hộp thư ý nghĩa', subtitle: 'Inbox of Meaning · cái gì quan trọng nhất lúc này',
    description: 'Không phải tin nhắn thô. Mỗi dòng là một đơn vị ý nghĩa đã được cấu trúc: nguồn, đối tượng, điểm số, tóm tắt hai câu, hành động đề xuất và chứng cứ gốc.',
    descMaxWidth: 700, designTitleRow: true,
  },
  {
    key: 'workbench', domain: 'business', parent: 'Hàng đợi & Hành động', icon: 'ph ph-pen-nib',
    name: 'Bàn làm việc', en: 'Workbench — soạn & duyệt',
    title: 'Bàn làm việc', subtitle: 'Workbench · soạn, duyệt, hành động',
    description: 'Workbench · soạn, duyệt, hành động', descMaxWidth: 700, designTitleRow: false,
  },
  {
    key: 'directory', domain: 'business', parent: null, icon: 'ph ph-address-book',
    name: 'Nhóm & Con người', en: 'Groups by channel · people filters',
    title: 'Nhóm & Con người', subtitle: 'Danh sách nhóm theo kênh và con người có bộ lọc',
    description: 'Danh sách nhóm tách theo từng kênh, và danh sách con người lọc được theo mức liên quan với Sếp, độ nhiệt, giá trị và mức ưu tiên — từ đó gán agent trực tương ứng.',
    descMaxWidth: 760, designTitleRow: true,
  },
  {
    key: 'graph', domain: 'business', parent: null, icon: 'ph ph-graph',
    name: 'Bản đồ quan hệ', en: 'Relationship Map',
    title: 'Bản đồ quan hệ', subtitle: 'Relationship Map · ai đang liên quan',
    description: 'Không phải danh bạ. Trọng số của mỗi quan hệ thay đổi theo tần suất, chiều tương tác và giai đoạn — nên thấy được ai là cầu nối, khách nào đang lạnh, ai đang ôm quá nhiều việc.',
    descMaxWidth: 700, designTitleRow: true,
  },
  {
    key: 'profile', domain: 'business', parent: 'Bản đồ quan hệ', icon: 'ph ph-identification-card',
    name: 'Hồ sơ sống', en: 'Living Profile — bấm một node để mở',
    title: 'Hồ sơ sống', subtitle: 'Living Profile · vì sao hệ thống nghĩ vậy',
    description: 'Living Profile · vì sao hệ thống nghĩ vậy', descMaxWidth: 700, designTitleRow: false,
  },
  {
    key: 'notebook', domain: 'business', parent: 'Bản đồ quan hệ', icon: 'ph ph-notebook',
    name: 'Sổ tay nhận thức', en: 'Assistant notebook per ID',
    title: 'Sổ tay nhận thức', subtitle: 'AI-trợ lý tự ghi nhận thức lũy tiến cho từng ID người và ID nhóm',
    description: 'Mỗi ID người và ID nhóm có một sổ tay riêng do AI-trợ lý tự ghi trong quá trình tương tác: nhận thức hiện tại, các mốc lũy tiến, và danh sách ID dữ liệu cần gọi lại khi cần. Đây là cửa sổ ngữ cảnh ngắn — không phải toàn bộ kho sạch.',
    descMaxWidth: 760, designTitleRow: true,
  },
  {
    key: 'opportunity', domain: 'business', parent: 'Cơ hội & Thị trường', icon: 'ph ph-target',
    name: 'Bảng cơ hội', en: 'Opportunity Board',
    title: 'Bảng cơ hội', subtitle: 'Opportunity Board · pipeline sống từ chat',
    description: 'Pipeline sống từ hội thoại, không phải form nhập tay. Mỗi thẻ trả lời: ai cần gì, nóng đến đâu, tin được đến đâu, nên ghép với ai, và mất gì nếu không làm gì.',
    descMaxWidth: 700, designTitleRow: true,
  },
  {
    key: 'supply', domain: 'business', parent: 'Cơ hội & Thị trường', icon: 'ph ph-arrows-left-right',
    name: 'Cung ↔ Cầu', en: 'Supply & Demand',
    title: 'Cung ↔ Cầu', subtitle: 'Ai cần mua, ai cần bán, ghép được với ai',
    description: 'Hai danh sách rút từ kho sạch: người đang cần nguồn hàng và người đang cần bán. Core agent đề xuất cặp ghép, Sếp quyết định có bắt tay hay không.',
    descMaxWidth: 760, designTitleRow: true,
  },
  {
    key: 'search', domain: 'business', parent: 'Cơ hội & Thị trường', icon: 'ph ph-brain',
    name: 'Kho hội thoại', en: 'Knowledge & Search',
    title: 'Kho hội thoại', subtitle: 'Knowledge & Search · tìm mẫu, không chỉ tìm câu',
    description: 'Tìm theo ý định, người, ngành hàng, khoảng giá, thời gian và thái độ — không chỉ theo chữ. Mục đích là tìm ra mẫu, không chỉ tìm ra câu.',
    descMaxWidth: 700, designTitleRow: true,
  },
  {
    key: 'people', domain: 'business', parent: 'Con người & Chất lượng', icon: 'ph ph-users-three',
    name: 'Đánh giá con người', en: 'People Review',
    title: 'Đánh giá con người', subtitle: 'People Review · điểm số có chứng cứ',
    description: 'Điểm số là công cụ hỗ trợ quản lý, không phải bản án. Mỗi dòng có xu hướng, tín hiệu nổi bật trong tuần, khuyến nghị và nút xem chứng cứ gốc.',
    descMaxWidth: 700, designTitleRow: true,
  },
  {
    key: 'care', domain: 'business', parent: 'Con người & Chất lượng', icon: 'ph ph-heartbeat',
    name: 'Chất lượng chăm sóc', en: 'Care Quality',
    title: 'Chất lượng chăm sóc', subtitle: 'Care Quality · cách chăm, không chỉ số lần nhắn',
    description: 'Hệ thống không chỉ biết đã nhắn hay chưa, mà biết cách nhắn: follow quá sớm hay quá muộn, hứa rồi quên, quên khách sau báo giá, và kịch bản nào đang chuyển thành deal.',
    descMaxWidth: 700, designTitleRow: true,
  },
  {
    key: 'raw', domain: 'tech', parent: 'Tầng dữ liệu', icon: 'ph ph-database',
    name: 'Kho dữ liệu thô', en: 'Raw Lake — bridge gom về',
    title: 'Kho dữ liệu thô', subtitle: 'Raw Lake · mọi bridge gom hết về đây trước khi phân loại',
    description: 'Mọi bridge lắng nghe gom hết về đây nguyên trạng, không xử lý gì. Core agent lấy từ kho này ra phân loại theo chu kỳ hoặc theo ngưỡng số lượng, rồi ghi kết quả sang kho sạch.',
    descMaxWidth: 760, designTitleRow: true,
  },
  {
    key: 'rules', domain: 'tech', parent: 'Tầng dữ liệu', icon: 'ph ph-funnel',
    name: 'Quy tắc sàng lọc', en: 'Refinery Rules',
    title: 'Quy tắc sàng lọc', subtitle: 'Refinery Rules · Sếp định nghĩa cách core agent đánh giá',
    description: 'Sếp định nghĩa cách core agent đọc dữ liệu thô: điều kiện nào thì gán nhãn gì, tính điểm theo trọng số nào, và khi nào mới đủ tin cậy để ghi vào kho sạch.',
    descMaxWidth: 760, designTitleRow: true,
  },
  {
    key: 'clean', domain: 'tech', parent: 'Tầng dữ liệu', icon: 'ph ph-check-circle',
    name: 'Kho sạch SSOT', en: 'Clean store & working memory',
    title: 'Kho sạch & Trí nhớ', subtitle: 'Clean SSOT · dữ liệu đã phân loại và trí nhớ tạm theo ID',
    description: 'Dữ liệu đã được core agent phân loại, gắn về ID nhóm và ID người. Agent trực kênh chỉ đọc từ đây cộng với trí nhớ tạm để quyết định nội dung phản hồi, rồi ghi kết quả trở lại.',
    descMaxWidth: 760, designTitleRow: true,
  },
  {
    key: 'identity', domain: 'tech', parent: 'Tầng dữ liệu', icon: 'ph ph-git-merge',
    name: 'Hợp nhất danh tính', en: 'Identity Resolution',
    title: 'Hợp nhất danh tính', subtitle: 'Identity Resolution · một người, nhiều kênh',
    description: 'Cùng một người xuất hiện trên nhiều kênh phải gộp được, nếu không toàn bộ dữ liệu sẽ vỡ thành mảnh. Hệ thống chỉ gợi ý — quyết định gộp hoặc tách là của Sếp.',
    descMaxWidth: 700, designTitleRow: true,
  },
  {
    key: 'agents', domain: 'tech', parent: 'Agent & Model', icon: 'ph ph-user-focus',
    name: 'Danh tính Agent', en: 'Agent Identity',
    title: 'Danh tính Agent', subtitle: 'Agent Identity · danh tính do Sếp định nghĩa',
    description: 'Agent là lớp mặt tiền có thể thay, không phải linh hồn cố định của hệ thống. Không có danh tính mặc định bắt buộc — Sếp tự đặt tên, vai trò, giọng nói, phạm vi kênh và mức tự trị cho từng agent.',
    descMaxWidth: 700, designTitleRow: true,
  },
  {
    key: 'api', domain: 'tech', parent: 'Agent & Model', icon: 'ph ph-plugs',
    name: 'API & Model', en: 'AI agent API settings',
    title: 'API & Model', subtitle: 'Khoá API, endpoint và tham số cho từng agent',
    description: 'Khoá API, endpoint và tham số sinh nội dung. Mỗi agent được gán một model riêng cho việc trực kênh, và core agent có model riêng cho việc sàng lọc dữ liệu thô.',
    descMaxWidth: 760, designTitleRow: true,
  },
  {
    key: 'mcp', domain: 'tech', parent: 'Agent & Model', icon: 'ph ph-plugs-connected',
    name: 'MCP Hub', en: 'External MCP servers',
    title: 'MCP Hub', subtitle: 'Máy chủ MCP bên ngoài mà agent được phép gọi',
    description: 'Cổng nối ra hệ thống bên ngoài: ERP, CRM, HRM, lịch, kho tài liệu. Agent chỉ gọi được những công cụ Sếp đã mở, và mọi lượt gọi đều ghi vào nhật ký.',
    descMaxWidth: 760, designTitleRow: true,
  },
  {
    key: 'plugins', domain: 'tech', parent: null, icon: 'ph ph-puzzle-piece',
    name: 'Plugin & Tiện ích', en: 'DSH base plugins & external add-ons',
    title: 'Plugin & Tiện ích', subtitle: 'Plugin nền DSH và plugin cài thêm từ bên ngoài',
    description: 'Mọi thành phần của hệ thống đều là plugin cắm rút nóng. Plugin nền DSH không tắt được vì khung gầm dựa vào chúng; plugin cài thêm thì tắt, cập nhật hoặc gỡ tuỳ ý. Một plugin lỗi chỉ ngắt mạch trong vùng cách ly của chính nó.',
    descMaxWidth: 760, designTitleRow: true,
  },
  {
    key: 'system', domain: 'tech', parent: null, icon: 'ph ph-sliders-horizontal',
    name: 'Điều khiển hệ thống', en: 'System Control — kênh, quyền, nhật ký',
    title: 'Điều khiển hệ thống', subtitle: 'System Control · kênh, quyền hạn, nhật ký',
    description: 'Góc kỹ thuật của Console: kênh và đăng nhập, bộ não AI, quyền hạn và nhật ký. Plugin có màn riêng. Chủ doanh nghiệp không bị bắt đầu từ đây.',
    descMaxWidth: 700, designTitleRow: true,
  },
];

export const SCREEN_BY_KEY: Record<string, ScreenMeta> = Object.fromEntries(SCREENS.map((s) => [s.key, s]));

/** Level-1 order of the design NAV, per domain. Group entries are parent names. */
export const NAV_ORDER: Record<DomainId, string[]> = {
  business: ['overview', 'Hàng đợi & Hành động', 'directory', 'graph', 'Cơ hội & Thị trường', 'Con người & Chất lượng'],
  tech: ['Tầng dữ liệu', 'Agent & Model', 'plugins', 'system'],
};

export interface ScreenTreeGroup {
  /** Screen key when the group is itself a screen (Bản đồ quan hệ). */
  key: string | null;
  name: string;
  icon: string;
  children: ScreenMeta[];
}
export interface ScreenTreeDomain extends DomainMeta {
  entries: Array<{ kind: 'screen'; screen: ScreenMeta } | { kind: 'group'; group: ScreenTreeGroup }>;
}

/** The domain → group → screen tree the router and breadcrumbs are built from. */
export function buildScreenTree(): ScreenTreeDomain[] {
  return (Object.keys(NAV_ORDER) as DomainId[]).map((d) => ({
    ...DOMAINS[d],
    entries: NAV_ORDER[d].map((entry) => {
      const own = SCREEN_BY_KEY[entry];
      const groupName = own ? own.name : entry;
      const children = SCREENS.filter((s) => s.domain === d && s.parent === groupName);
      if (children.length) {
        return {
          kind: 'group' as const,
          group: {
            key: own ? own.key : null,
            name: own ? own.name : entry,
            icon: own ? own.icon : (GROUP_ICONS[entry] ?? 'ph ph-folder'),
            children,
          },
        };
      }
      if (!own) throw new Error(`NAV_ORDER entry "${entry}" is neither a screen nor a group`);
      return { kind: 'screen' as const, screen: own };
    }),
  }));
}
