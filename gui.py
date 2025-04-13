"""图形用户界面模块

实现程序的GUI部分，包括窗口、控件和用户交互。"""

# --- 导入语句 ---
import subprocess
import os # 确保 os 被导入
import sys # 确保 sys 被导入
from datetime import datetime
from tkinter import messagebox, filedialog
import asyncio
import concurrent.futures
import io
import json
import os
import queue
import sys
import threading
import time
import tkinter as tk
import tkinter.ttk as ttk
import traceback
import re
try:
    import aiohttp
except ImportError:
    print('警告: 未安装aiohttp库，请确保已安装: pip install aiohttp')

# 导入Cloudflare视频分析客户端
import sys
import os

# 添加视频转写工具目录到Python路径
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.append(current_dir)

try:
    from 前端调用代码 import VideoAnalysisClient, CONFIG as CF_CONFIG
    print('已成功导入Cloudflare客户端')
except ImportError as e:
    print(f'警告: 未找到Cloudflare视频分析客户端: {str(e)}')
    raise # 如果找不到模块，让程序报错而不是使用假模块

# --- 项目内部导入 ---
from .api_client import extract_douyin_link_from_text, extract_douyin_url_sync
from .utils import extract_text
from .utils import save_results_to_file
import settings
import os
import sys
import traceback

# --- 循环导入处理 ---
# 避免循环导入
try:
    from .workers import worker
except ImportError:
    worker = None
try:
    from .api_client import extract_douyin_url
except ImportError:
    extract_douyin_url = None

# --- 辅助函数 ---
def resource_path(relative_path):
    """ 获取资源的绝对路径，适用于开发环境和 PyInstaller 打包环境 """
    try:
        # PyInstaller 创建临时文件夹并将路径存储在 _MEIPASS
        base_path = sys._MEIPASS
    except Exception:
        # 在开发环境中，使用当前文件的目录
        base_path = os.path.dirname(os.path.abspath(__file__))

    return os.path.join(base_path, relative_path)

# --- 模块代码 ---
class TextRedirector(io.TextIOBase):
    """用于重定向标准输出和标准错误到Tkinter的Text组件"""

    def __init__(self, app, tag='stdout'):
        self.app = app
        self.tag = tag
        self.buffer = ''

    def write(self, string):
        self.buffer += string
        if '\n' in string:
            self.flush()
        return len(string)

    def flush(self):
        if self.buffer:
            if self.tag == 'stderr':
                self.app.add_log(f'[错误] {self.buffer}')
            else:
                self.app.add_log(self.buffer)
            self.buffer = ''

class VideoTranscriptionApp:

    def __init__(self, root):
        """初始化SMASH AI Video Transcription App"""
        self.root = root
        self.root.title('热点火花收集工具 - 作者: jacky') # 恢复原始标题或保持现状？暂定保留原始
        self.root.geometry('800x600') # 恢复原始窗口大小
        style = ttk.Style()
        style.configure('TButton', padding=6, relief='flat', background='#ccc') # 恢复原始样式
        main_frame = ttk.Frame(root, padding='10') # 恢复原始主框架定义
        main_frame.pack(fill=tk.BOTH, expand=True)
        notebook = ttk.Notebook(main_frame)
        notebook.pack(fill=tk.BOTH, expand=True, pady=5)
        self.video_frame = ttk.Frame(notebook, padding='5')
        notebook.add(self.video_frame, text='提取文案')
        self.url_parser_frame = ttk.Frame(notebook, padding='5')
        notebook.add(self.url_parser_frame, text='链接解析')
        # 添加新的画面提取 Frame
        self.image_frame = ttk.Frame(notebook, padding='5')
        notebook.add(self.image_frame, text='提取画面')
        self.log_frame = ttk.Frame(notebook, padding='5')
        notebook.add(self.log_frame, text='运行日志')
        self.results_frame = ttk.Frame(notebook, padding='5')
        notebook.add(self.results_frame, text='转写结果')
        self.settings_frame = ttk.Frame(notebook, padding='5')
        notebook.add(self.settings_frame, text='设置')
        self.introduction_frame = ttk.Frame(notebook, padding='5')
        notebook.add(self.introduction_frame, text='介绍')
        
        # --- 提取画面标签页状态变量 ---
        self.cf_client = VideoAnalysisClient(CF_CONFIG) # CF客户端实例
        self.image_task_queue = queue.Queue()          # 存放原始 URL
        self.image_pending_cf_tasks = {}               # {cf_task_id: original_url} - CF任务跟踪
        self.image_results = {}                        # {original_url: formatted_result_or_error} - 存放最终结果
        self.image_raw_results = {}                    # {original_url: raw_response} - 存放原始响应数据
        self.image_running = False                     # 控制此标签页任务运行状态
        self.image_tasks_completed = 0                 # 已完成/失败的任务计数
        self.image_total_tasks = 0                     # 本次任务总数
        self.image_manager_thread = None               # 主管理线程 (运行asyncio循环)
        self.image_poller_thread = None                # 状态轮询线程
        self.image_lock = threading.Lock()             # 线程锁，用于保护共享字典
        self.image_all_cf_tasks_processed = threading.Event() # 用于通知管理线程所有CF任务已处理
        # --- 提取画面标签页状态变量结束 ---

        # --- 提示词相关变量 ---
        # 在开发环境和打包环境下都能正确工作的提示词目录路径
        self.PROMPT_DIR = resource_path("提示词")
        # --- 提示词变量结束 ---

        # --- 提前初始化界面变量 ---
        # 创建 StringVar 变量
        self.file_path = tk.StringVar(value="")
        default_text_save_dir = os.path.join(os.path.expanduser('~'), 'Desktop', 'coze_api_data', 'text')
        self.save_path = tk.StringVar(value=default_text_save_dir) # Video Frame
        self.taskid_file_path = tk.StringVar() # Video Frame Polling
        default_poll_save_dir = os.path.join(os.path.expanduser('~'), 'Desktop', '文案提取')
        self.poll_save_path = tk.StringVar(value=default_poll_save_dir) # Video Frame Polling
        self.image_file_path = tk.StringVar(value="") # Image Frame
        default_image_save_dir = os.path.join(os.path.expanduser('~'), 'Desktop', '画面提取结果')
        self.image_save_path = tk.StringVar(value=default_image_save_dir) # Image Frame
        self.parser_file_path = tk.StringVar() # Parser Frame
        default_parser_save_dir = os.path.join(os.path.expanduser('~'), 'Desktop', '解析结果')
        self.parser_save_path = tk.StringVar(value=default_parser_save_dir) # Parser Frame
        self.api_key = tk.StringVar(value=settings.API_KEY) # Settings Frame
        # self.direct_file_path = tk.StringVar(value="") # Not used currently?
        # self.direct_save_path = tk.StringVar(value="") # Not used currently?

        # 创建 IntVar/BooleanVar 变量
        self.concurrent = tk.IntVar(value=3) # Video Frame
        self.max_polling = tk.IntVar(value=10) # Video Frame
        self.auto_save = tk.BooleanVar(value=True) # Video Frame
        self.poll_concurrent = tk.IntVar(value=3) # Video Frame Polling
        self.poll_max_polling = tk.IntVar(value=10) # Video Frame Polling
        self.poll_auto_save = tk.BooleanVar(value=False) # Video Frame Polling
        self.progress_var = tk.DoubleVar(value=0) # Video Frame Progress
        self.image_concurrent = tk.IntVar(value=3) # Image Frame
        self.image_auto_save = tk.BooleanVar(value=True) # Image Frame
        self.parser_concurrent = tk.IntVar(value=3) # Parser Frame
        self.parser_auto_save = tk.BooleanVar(value=False) # Parser Frame
        self.parser_progress_var = tk.DoubleVar(value=0) # Parser Frame Progress
        # self.direct_auto_save = tk.BooleanVar(value=True) # Not used currently?
        # self.include_source = tk.BooleanVar(value=True) # Not used currently?
        # self.include_logs = tk.BooleanVar(value=True) # Not used currently?
        # 创建显示消息
        self.message = tk.StringVar(value="就绪")
        # --- 界面变量初始化结束 ---

        # 恢复原始的构建调用顺序，移除错误的_build_main_interface调用
        self._build_video_frame()
        self._build_url_parser_frame()
        # 调用新的构建方法
        self._build_image_frame()
        self._build_log_frame()
        self._build_results_frame()
        self._build_settings_frame()
        self._build_introduction_frame()
        self.stdout_redirector = TextRedirector(self)
        self.stderr_redirector = TextRedirector(self, 'stderr')
        sys.stdout = self.stdout_redirector
        sys.stderr = self.stderr_redirector
        self.add_log('程序启动，控制台输出已重定向到日志区域')
        
        # 创建日志消息队列和锁
        self.log_queue = queue.Queue()
        self.log_lock = threading.Lock()
        
        # 创建控制标志和线程存储
        self.running = False
        self.manager_thread = None
        self.poller_thread = None
        self.complete_event = threading.Event()
        
        # 视频处理相关变量
        self.pending_cf_tasks = {}  # {cf_task_id: original_url}
        self.results = {}  # {original_url: formatted_result}
        self.tasks_completed = 0
        self.total_tasks = 0
        self.queue_tasks = queue.Queue()
        self.failed_urls = set()
        self.retry_count = {}
        
        # 创建图片处理相关变量
        self.image_running = False
        self.image_manager_thread = None
        self.image_poller_thread = None
        self.image_all_cf_tasks_processed = threading.Event()
        
        # 图片处理相关变量
        self.image_pending_cf_tasks = {}  # {cf_task_id: original_url}
        self.image_results = {}  # {original_url: formatted_result}
        self.image_raw_results = {}  # {original_url: raw_response_data}
        self.image_tasks_completed = 0
        self.image_total_tasks = 0
        self.image_queue_tasks = queue.Queue()
        self.image_failed_urls = set()
        self.image_retry_count = {}
        
        # 直接分析相关变量
        self.direct_analysis_running = False
        self.direct_analysis_thread = None
        self.direct_analysis_results = {}
        self.direct_tasks_completed = 0
        self.direct_total_tasks = 0
        
        # 创建用于线程同步的锁
        self.lock = threading.Lock()
        self.image_lock = threading.Lock()
        self.direct_analysis_lock = threading.Lock()

        # 创建 StringVar 变量  <--- 这些移到前面去了
        # self.file_path = tk.StringVar(value="")
        # self.image_file_path = tk.StringVar(value="")
        # self.direct_file_path = tk.StringVar(value="")
        # self.direct_save_path = tk.StringVar(value="")

        # 创建 IntVar/BooleanVar 变量 <--- 这些移到前面去了
        # self.auto_save = tk.BooleanVar(value=True)
        # self.image_auto_save = tk.BooleanVar(value=True)
        # self.direct_auto_save = tk.BooleanVar(value=True)
        # self.include_source = tk.BooleanVar(value=True)
        # self.include_logs = tk.BooleanVar(value=True)

        # 创建客户端
        self.cf_client = VideoAnalysisClient(CF_CONFIG)

        # 创建显示消息 <--- 这个也移到前面去了
        # self.message = tk.StringVar(value="就绪")

        # 尝试从配置中读取默认保存路径
        self._load_default_save_paths()
        
        # 启动后台解析服务
        self._start_analysis_service()
        
        # 设置窗口关闭事件处理
        root.protocol("WM_DELETE_WINDOW", self._on_closing)
        
        # 定期更新任务状态的定时器 (每秒刷新)
        self._update_status()

    def _load_default_save_paths(self):
        """(Placeholder) 加载或设置默认的保存路径"""
        # This method was missing, causing an AttributeError.
        # Adding a placeholder definition to resolve the error.
        # Original logic for loading paths from config might be needed.
        self.add_log("调用 _load_default_save_paths (当前为占位符)")

    def _on_closing(self):
        """处理窗口关闭事件，尝试终止后台服务"""
        # 尝试终止后台解析服务
        if hasattr(self, 'analysis_process') and self.analysis_process:
            try:
                # 检查进程是否仍在运行 (poll() 返回 None 表示仍在运行)
                if self.analysis_process.poll() is None:
                    self.add_log(f"正在尝试终止后台解析服务 (PID: {self.analysis_process.pid})...")
                    self.analysis_process.terminate() # 发送终止信号
                    # 可以选择等待一小段时间确保进程退出，或直接继续
                    # self.analysis_process.wait(timeout=1) 
                    self.add_log("已发送终止信号给后台服务。")
                else:
                    self.add_log("后台解析服务已自行退出。")
            except Exception as e:
                self.add_log(f"尝试终止后台服务时出错: {str(e)}")
        
        # 停止其他可能的后台线程 (示例，根据实际情况调整)
        if self.image_running:
             self._stop_frame_extraction()
        if settings.RUNNING: # 检查全局运行标志
             # 根据需要调用相应的停止函数，例如:
             # self._stop_processing() # 如果文案提取在运行
             # self._stop_polling()    # 如果轮询在运行
             # self._stop_parsing()    # 如果解析在运行
             pass # 需要具体实现停止逻辑

        # 最后销毁窗口
        self.root.destroy()

    def _update_status(self):
        """(Placeholder) 定期更新状态信息"""
        # This method was missing, causing an AttributeError during init.
        # Needs logic to update status labels or progress bars periodically.
        # self.add_log("调用 _update_status (当前为占位符)") 
        # Example (Needs refinement):
        # status_message = f"就绪 | 视频任务: {'运行中' if settings.RUNNING else '空闲'} | 画面任务: {'运行中' if self.image_running else '空闲'}"
        # self.message.set(status_message)
        # self.root.after(1000, self._update_status) # Schedule next update
        pass # Temporarily pass to avoid logging every second

    def _build_main_interface(self):
        """构建主界面"""
        main_frame = ttk.Frame(self.root)
        main_frame.pack(fill=tk.BOTH, expand=True)
        notebook = ttk.Notebook(main_frame)
        notebook.pack(fill=tk.BOTH, expand=True, pady=5)
        self.video_frame = ttk.Frame(notebook, padding='5')
        notebook.add(self.video_frame, text='提取文案')
        self.url_parser_frame = ttk.Frame(notebook, padding='5')
        notebook.add(self.url_parser_frame, text='链接解析')
        # 添加新的画面提取 Frame
        self.image_frame = ttk.Frame(notebook, padding='5')
        notebook.add(self.image_frame, text='提取画面')
        self.log_frame = ttk.Frame(notebook, padding='5')
        notebook.add(self.log_frame, text='运行日志')
        self.results_frame = ttk.Frame(notebook, padding='5')
        notebook.add(self.results_frame, text='转写结果')
        self.settings_frame = ttk.Frame(notebook, padding='5')
        notebook.add(self.settings_frame, text='设置')
        self.introduction_frame = ttk.Frame(notebook, padding='5')
        notebook.add(self.introduction_frame, text='介绍')
        
        # --- 提取画面标签页状态变量 ---
        self.cf_client = VideoAnalysisClient(CF_CONFIG) # CF客户端实例
        self.image_task_queue = queue.Queue()          # 存放原始 URL
        self.image_pending_cf_tasks = {}               # {cf_task_id: original_url} - CF任务跟踪
        self.image_results = {}                        # {original_url: formatted_result_or_error} - 存放最终结果
        self.image_raw_results = {}                    # {original_url: raw_response} - 存放原始响应数据
        self.image_running = False                     # 控制此标签页任务运行状态
        self.image_tasks_completed = 0                 # 已完成/失败的任务计数
        self.image_total_tasks = 0                     # 本次任务总数
        self.image_manager_thread = None               # 主管理线程 (运行asyncio循环)
        self.image_poller_thread = None                # 状态轮询线程
        self.image_lock = threading.Lock()             # 线程锁，用于保护共享字典
        self.image_all_cf_tasks_processed = threading.Event() # 用于通知管理线程所有CF任务已处理
        # --- 提取画面标签页状态变量结束 ---

        self._build_video_frame()
        self._build_url_parser_frame()
        # 调用新的构建方法
        self._build_image_frame()
        self._build_log_frame()
        self._build_results_frame()
        self._build_settings_frame()
        self._build_introduction_frame()
        self.stdout_redirector = TextRedirector(self)
        self.stderr_redirector = TextRedirector(self, 'stderr')
        sys.stdout = self.stdout_redirector
        sys.stderr = self.stderr_redirector
        self.add_log('程序启动，控制台输出已重定向到日志区域')

    def _build_introduction_frame(self):
        """构建介绍界面"""
        title_frame = ttk.Frame(self.introduction_frame, padding='5')
        title_frame.pack(fill=tk.X, pady=5)
        ttk.Label(title_frame, text='热点火花收集工具使用说明', font=('Arial', 14, 'bold')).pack(anchor=tk.CENTER, padx=5, pady=10)
        main_canvas = tk.Canvas(self.introduction_frame)
        scrollbar = ttk.Scrollbar(self.introduction_frame, orient='vertical', command=main_canvas.yview)
        scrollable_frame = ttk.Frame(main_canvas)
        scrollable_frame.bind('<Configure>', lambda e: main_canvas.configure(scrollregion=main_canvas.bbox('all')))
        main_canvas.create_window((0, 0), window=scrollable_frame, anchor='nw')
        main_canvas.configure(yscrollcommand=scrollbar.set)
        main_canvas.pack(side='left', fill='both', expand=True, padx=10, pady=10)
        scrollbar.pack(side='right', fill='y')
        section1 = ttk.LabelFrame(scrollable_frame, text='一、主要功能区', padding='10')
        section1.pack(fill=tk.X, expand=True, pady=5, padx=5)
        content1_text = tk.Text(section1, height=25, width=80, wrap=tk.WORD)
        content1_text.pack(fill=tk.X, expand=True, padx=5, pady=5)
        content1_text.insert(tk.END, '### 1. 视频转写区域\n')
        content1_text.insert(tk.END, '- **功能**：将视频链接批量转写为文本\n')
        content1_text.insert(tk.END, '- **支持格式**：抖音视频链接和其他标准视频链接\n')
        content1_text.insert(tk.END, '- **处理流程**：\n')
        content1_text.insert(tk.END, '  - URL列表→调用API解析为CDN可下载链接→调用阿里热点火花(Paraformer录音文件识别API)→提交异步转文本\n')
        content1_text.insert(tk.END, '  - 系统会自动解析原始URL为可下载的CDN链接\n')
        content1_text.insert(tk.END, '  - 然后调用阿里热点火花API将视频转为文本\n')
        content1_text.insert(tk.END, '  - 支持异步处理多个视频链接\n')
        content1_text.insert(tk.END, '- **使用方法**：\n')
        content1_text.insert(tk.END, '  - 在URL列表文本框中输入要转写的视频链接（每行一个）\n')
        content1_text.insert(tk.END, '  - 或通过"浏览"按钮从文件导入链接\n')
        content1_text.insert(tk.END, '  - 设置并发数（同时处理的视频数量）和最大轮询次数\n')
        content1_text.insert(tk.END, '  - 点击"开始转写"按钮启动处理\n')
        content1_text.insert(tk.END, '  - 结果会实时显示在转写结果区域\n')
        content1_text.insert(tk.END, '  - 可选择自动保存结果到指定目录\n')
        content1_text.insert(tk.END, '- **设置选项**：\n')
        content1_text.insert(tk.END, '  - 并发数：控制同时处理的视频数量（1-10）\n')
        content1_text.insert(tk.END, '  - 最大轮询次数：控制查询任务状态的最大次数（1-50）\n')
        content1_text.insert(tk.END, '  - 自动保存：处理完成后自动保存结果到指定目录\n')
        content1_text.insert(tk.END, '  - 保存位置：指定结果文件的保存目录\n')
        content1_text.insert(tk.END, '- **结果处理**：\n')
        content1_text.insert(tk.END, '  - 成功结果显示：原始URL + 转写文本\n')
        content1_text.insert(tk.END, '  - 失败结果显示：原始URL + API完整响应\n')
        content1_text.insert(tk.END, '  - 保存格式为JSON，包含message、url、text、videoUrl、taskId、timestamp字段\n\n')
        content1_text.insert(tk.END, '### 2. 任务轮询区域\n')
        content1_text.insert(tk.END, '- **功能**：根据任务ID直接查询转写结果，无需重新解析URL\n')
        content1_text.insert(tk.END, '- **使用方法**：\n')
        content1_text.insert(tk.END, '  - 在任务ID列表中输入要查询的任务ID（每行一个）\n')
        content1_text.insert(tk.END, '  - 或通过"浏览"按钮从文件加载任务ID\n')
        content1_text.insert(tk.END, '  - 设置并发数和最大轮询次数\n')
        content1_text.insert(tk.END, '  - 点击"开始轮询"按钮启动处理\n')
        content1_text.insert(tk.END, '  - 结果会显示在转写结果区域\n')
        content1_text.insert(tk.END, '- **设置选项**：\n')
        content1_text.insert(tk.END, '  - 并发数：控制同时查询的任务数量（1-10）\n')
        content1_text.insert(tk.END, '  - 最大轮询次数：控制查询任务状态的最大次数（默认10次）\n')
        content1_text.insert(tk.END, '  - 自动保存结果：轮询完成后自动保存结果\n')
        content1_text.insert(tk.END, '  - 保存位置：指定结果文件的保存目录（默认为C:/Users/Administrator/Desktop/coze_api_data/text）\n')
        content1_text.insert(tk.END, '- **结果保存**：\n')
        content1_text.insert(tk.END, '  - 保存为JSON格式，包含text、taskId、timestamp字段\n')
        content1_text.configure(state='disabled')
        section2 = ttk.LabelFrame(scrollable_frame, text='二、辅助功能区', padding='10')
        section2.pack(fill=tk.X, expand=True, pady=5, padx=5)
        content2_text = tk.Text(section2, height=15, width=80, wrap=tk.WORD)
        content2_text.pack(fill=tk.X, expand=True, padx=5, pady=5)
        content2_text.insert(tk.END, '### 1. 运行日志区域\n')
        content2_text.insert(tk.END, '- **功能**：显示程序的运行状态、处理进度和错误信息\n')
        content2_text.insert(tk.END, '- **使用方法**：\n')
        content2_text.insert(tk.END, '  - 自动记录程序运行过程中的所有操作和状态\n')
        content2_text.insert(tk.END, '  - 可通过"清空日志"按钮清除日志内容\n')
        content2_text.insert(tk.END, '  - 可通过"导出日志"按钮保存日志到文件\n\n')
        content2_text.insert(tk.END, '### 2. 转写结果区域\n')
        content2_text.insert(tk.END, '- **功能**：显示视频转写或任务轮询的结果文本\n')
        content2_text.insert(tk.END, '- **使用方法**：\n')
        content2_text.insert(tk.END, '  - 自动显示处理完成的转写文本\n')
        content2_text.insert(tk.END, '  - 可通过"保存结果"按钮手动保存当前结果\n')
        content2_text.insert(tk.END, '  - 可通过"复制结果"按钮复制结果到剪贴板\n')
        content2_text.insert(tk.END, '  - 可通过"清空结果"按钮清除结果区域\n\n')
        content2_text.insert(tk.END, '### 3. 设置区域\n')
        content2_text.insert(tk.END, '- **功能**：配置程序的API密钥和其他全局设置\n')
        content2_text.insert(tk.END, '- **选项**：\n')
        content2_text.insert(tk.END, '  - API密钥设置：用于访问百炼转写API\n')
        content2_text.insert(tk.END, '  - 关于信息：程序版本和作者信息\n')
        content2_text.configure(state='disabled')
        section3 = ttk.LabelFrame(scrollable_frame, text='三、特殊功能', padding='10')
        section3.pack(fill=tk.X, expand=True, pady=5, padx=5)
        content3_text = tk.Text(section3, height=22, width=80, wrap=tk.WORD)
        content3_text.pack(fill=tk.X, expand=True, padx=5, pady=5)
        content3_text.insert(tk.END, '### 1. 视频链接解析\n')
        content3_text.insert(tk.END, '- **特性**：自动将原始视频链接解析为CDN可下载链接\n')
        content3_text.insert(tk.END, '- **处理流程**：\n')
        content3_text.insert(tk.END, '  - 通过API解析原始URL为CDN直接下载链接\n')
        content3_text.insert(tk.END, '  - 直接使用解析后的链接进行转写\n')
        content3_text.insert(tk.END, '  - 保留原始链接用于结果标识和显示\n\n')
        content3_text.insert(tk.END, '### 2. 批量文件处理\n')
        content3_text.insert(tk.END, '- **功能**：从文件中批量导入链接或任务ID\n')
        content3_text.insert(tk.END, '- **支持格式**：\n')
        content3_text.insert(tk.END, '  - 文本文件（每行一个链接/任务ID）\n')
        content3_text.insert(tk.END, '  - JSON文件（自动提取URL字段）\n\n')
        content3_text.insert(tk.END, '### 3. 结果保存\n')
        content3_text.insert(tk.END, '- **视频转写区保存格式**：\n')
        content3_text.insert(tk.END, '```json\n')
        content3_text.insert(tk.END, '[\n')
        content3_text.insert(tk.END, '  {\n')
        content3_text.insert(tk.END, '    "message": "任务已完成", // 或错误信息\n')
        content3_text.insert(tk.END, '    "url": "https://www.douyin.com/video/xxx", // 原始URL\n')
        content3_text.insert(tk.END, '    "text": "转写文本内容",\n')
        content3_text.insert(tk.END, '    "videoUrl": "https://v3-xxx.com/xxx", // 解析后的URL\n')
        content3_text.insert(tk.END, '    "taskId": "任务ID",\n')
        content3_text.insert(tk.END, '    "timestamp": "保存时间"\n')
        content3_text.insert(tk.END, '  }\n')
        content3_text.insert(tk.END, ']\n')
        content3_text.insert(tk.END, '```\n\n')
        content3_text.insert(tk.END, '- **轮询区保存格式**：\n')
        content3_text.insert(tk.END, '```json\n')
        content3_text.insert(tk.END, '[\n')
        content3_text.insert(tk.END, '  {\n')
        content3_text.insert(tk.END, '    "text": "转写文本内容",\n')
        content3_text.insert(tk.END, '    "taskId": "任务ID",\n')
        content3_text.insert(tk.END, '    "timestamp": "保存时间"\n')
        content3_text.insert(tk.END, '  }\n')
        content3_text.insert(tk.END, ']\n')
        content3_text.insert(tk.END, '```\n')
        content3_text.configure(state='disabled')
        section4 = ttk.LabelFrame(scrollable_frame, text='四、使用注意事项', padding='10')
        section4.pack(fill=tk.X, expand=True, pady=5, padx=5)
        content4_text = tk.Text(section4, height=15, width=80, wrap=tk.WORD)
        content4_text.pack(fill=tk.X, expand=True, padx=5, pady=5)
        content4_text.insert(tk.END, '1. **视频链接解析**：\n')
        content4_text.insert(tk.END, '   - 系统使用专用API解析链接，无需手动处理\n')
        content4_text.insert(tk.END, '   - 支持抖音等多种平台的视频链接\n')
        content4_text.insert(tk.END, '   - 某些特殊限制的视频可能无法成功解析\n\n')
        content4_text.insert(tk.END, '2. **错误处理**：\n')
        content4_text.insert(tk.END, '   - 视频链接不可直接访问时会提示错误信息\n')
        content4_text.insert(tk.END, '   - API请求失败会自动重试\n')
        content4_text.insert(tk.END, '   - 轮询过程中可随时停止任务\n\n')
        content4_text.insert(tk.END, '3. **系统要求**：\n')
        content4_text.insert(tk.END, '   - 需要安装Python及相关依赖库\n')
        content4_text.insert(tk.END, '   - 需要网络连接以访问API服务\n\n')
        content4_text.insert(tk.END, '4. **性能优化**：\n')
        content4_text.insert(tk.END, '   - 并发数设置建议根据电脑性能和网络状况调整\n')
        content4_text.insert(tk.END, '   - 处理大量视频时建议适当降低并发数\n')
        content4_text.configure(state='disabled')

    def _build_video_frame(self):
        # 创建主 Canvas 用于滚动
        main_canvas = tk.Canvas(self.video_frame)
        main_canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        # 创建滚动条并关联 Canvas
        scrollbar = ttk.Scrollbar(self.video_frame, orient=tk.VERTICAL, command=main_canvas.yview)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        main_canvas.configure(yscrollcommand=scrollbar.set)

        # 创建一个 Frame 放在 Canvas 内部，用于容纳所有内容
        scrollable_frame = ttk.Frame(main_canvas)
        scrollable_frame.bind("<Configure>", lambda e: main_canvas.configure(scrollregion=main_canvas.bbox("all")))
        main_canvas.create_window((0, 0), window=scrollable_frame, anchor="nw")

        # --- 添加鼠标滚轮事件绑定 --- (新添加)
        def _on_mousewheel(event):
            # 在 Windows 和 macOS 上, event.delta 是垂直滚动的像素数
            # 在 Linux 上, Button-4 是向上滚动, Button-5 是向下滚动
            if event.num == 4 or event.delta > 0:
                main_canvas.yview_scroll(-1, "units")
            elif event.num == 5 or event.delta < 0:
                main_canvas.yview_scroll(1, "units")

        # 绑定到 Canvas (推荐)
        main_canvas.bind_all("<MouseWheel>", _on_mousewheel) # Windows/macOS
        main_canvas.bind_all("<Button-4>", _on_mousewheel)   # Linux 向上
        main_canvas.bind_all("<Button-5>", _on_mousewheel)   # Linux 向下

        # 也可以尝试绑定到内部 frame (如果绑定 Canvas 不理想)
        # scrollable_frame.bind("<MouseWheel>", _on_mousewheel)
        # scrollable_frame.bind("<Button-4>", _on_mousewheel)
        # scrollable_frame.bind("<Button-5>", _on_mousewheel)
        # --- 事件绑定结束 ---

        # --- 将原有的控件放入 scrollable_frame 中 ---
        input_frame = ttk.LabelFrame(scrollable_frame, text='视频处理', padding='10') # 父容器改为 scrollable_frame
        input_frame.pack(fill=tk.X, pady=5)
        ttk.Label(input_frame, text='URL列表:').grid(column=0, row=0, sticky=tk.W, padx=5, pady=5)
        self.url_text = tk.Text(input_frame, height=5, width=70)
        self.url_text.grid(column=0, row=1, sticky=tk.EW, padx=5, pady=5, columnspan=2)
        ttk.Label(input_frame, text='选择文件:').grid(column=0, row=2, sticky=tk.W, padx=5, pady=5)
        # self.file_path 在 __init__ 中初始化
        ttk.Entry(input_frame, textvariable=self.file_path, width=50).grid(column=0, row=3, sticky=tk.EW, padx=5, pady=5)
        ttk.Button(input_frame, text='浏览', command=self._browse_file).grid(column=1, row=3, sticky=tk.W, padx=5, pady=5)
        ttk.Label(input_frame, text='保存位置:').grid(column=0, row=4, sticky=tk.W, padx=5, pady=5)
        # self.save_path 在 __init__ 中初始化
        ttk.Entry(input_frame, textvariable=self.save_path, width=50).grid(column=0, row=5, sticky=tk.EW, padx=5, pady=5)
        ttk.Button(input_frame, text='浏览', command=self._browse_save_dir).grid(column=1, row=5, sticky=tk.W, padx=5, pady=5)
        control_frame = ttk.Frame(input_frame)
        control_frame.grid(column=0, row=6, sticky=tk.W, padx=5, pady=5, columnspan=2)
        ttk.Label(control_frame, text='并发数:').pack(side=tk.LEFT, padx=5)
        # self.concurrent 在 __init__ 中初始化
        ttk.Spinbox(control_frame, from_=1, to=10, textvariable=self.concurrent, width=5).pack(side=tk.LEFT, padx=5)
        ttk.Label(control_frame, text='最大轮询数:').pack(side=tk.LEFT, padx=5)
        # self.max_polling 在 __init__ 中初始化
        ttk.Spinbox(control_frame, from_=1, to=50, textvariable=self.max_polling, width=5).pack(side=tk.LEFT, padx=5)
        # self.auto_save 在 __init__ 中初始化
        ttk.Checkbutton(control_frame, text='自动保存', variable=self.auto_save).pack(side=tk.LEFT, padx=15)

        button_frame = ttk.Frame(scrollable_frame) # 父容器改为 scrollable_frame
        button_frame.pack(fill=tk.X, pady=10)
        self.start_button = ttk.Button(button_frame, text='开始转写', command=self._start_processing)
        self.start_button.pack(side=tk.LEFT, padx=5)
        self.stop_button = ttk.Button(button_frame, text="停止转写", command=self._stop_processing, state=tk.DISABLED)
        self.stop_button.pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text="清空输入", command=self._clear_url_input).pack(side=tk.LEFT, padx=5)

        polling_frame = ttk.LabelFrame(scrollable_frame, text="任务轮询", padding="10") # 父容器改为 scrollable_frame
        polling_frame.pack(fill=tk.X, pady=10, padx=5)
        taskid_frame = ttk.Frame(polling_frame)
        taskid_frame.pack(fill=tk.X, pady=5)
        ttk.Label(taskid_frame, text='任务ID列表:').pack(side=tk.LEFT, padx=5)
        self.taskid_text = tk.Text(taskid_frame, height=3, width=50)
        self.taskid_text.pack(side=tk.LEFT, padx=5, fill=tk.X, expand=True)
        taskid_file_frame = ttk.Frame(polling_frame)
        taskid_file_frame.pack(fill=tk.X, pady=5)
        ttk.Label(taskid_file_frame, text='从文件加载:').pack(side=tk.LEFT, padx=5)
        # self.taskid_file_path 在 __init__ 中初始化
        ttk.Entry(taskid_file_frame, textvariable=self.taskid_file_path, width=50).pack(side=tk.LEFT, padx=5)
        ttk.Button(taskid_file_frame, text='浏览', command=self._browse_poll_file).pack(side=tk.LEFT, padx=5)
        poll_setting_frame = ttk.Frame(polling_frame)
        poll_setting_frame.pack(fill=tk.X, pady=5)
        ttk.Label(poll_setting_frame, text='保存位置:').pack(side=tk.LEFT, padx=5)
        # self.poll_save_path 在 __init__ 中初始化
        ttk.Entry(poll_setting_frame, textvariable=self.poll_save_path, width=50).pack(side=tk.LEFT, padx=5)
        ttk.Button(poll_setting_frame, text='浏览', command=self._browse_poll_save_dir).pack(side=tk.LEFT, padx=5)
        poll_control_frame = ttk.Frame(polling_frame)
        poll_control_frame.pack(fill=tk.X, pady=5)
        ttk.Label(poll_control_frame, text='并发数:').pack(side=tk.LEFT, padx=5)
        # self.poll_concurrent 在 __init__ 中初始化
        ttk.Spinbox(poll_control_frame, from_=1, to=10, textvariable=self.poll_concurrent, width=5).pack(side=tk.LEFT, padx=5)
        ttk.Label(poll_control_frame, text='最大轮询次数:').pack(side=tk.LEFT, padx=5)
        # self.poll_max_polling 在 __init__ 中初始化
        ttk.Spinbox(poll_control_frame, from_=1, to=50, textvariable=self.poll_max_polling, width=5).pack(side=tk.LEFT, padx=5)
        # self.poll_auto_save 在 __init__ 中初始化
        ttk.Checkbutton(poll_control_frame, text='自动保存结果', variable=self.poll_auto_save).pack(side=tk.LEFT, padx=15)
        poll_button_frame = ttk.Frame(polling_frame)
        poll_button_frame.pack(fill=tk.X, pady=5)
        self.poll_button = ttk.Button(poll_button_frame, text='开始轮询', command=self._start_polling_by_taskid)
        self.poll_button.pack(side=tk.LEFT, padx=5)
        self.stop_poll_button = ttk.Button(poll_button_frame, text='停止轮询', command=self._stop_polling, state=tk.DISABLED)
        self.stop_poll_button.pack(side=tk.LEFT, padx=5)
        ttk.Button(poll_button_frame, text='清空任务', command=self._clear_taskids).pack(side=tk.LEFT, padx=5)
        help_text = '这个区域用于直接查询任务状态，不需要解析URL。输入任务ID后点击开始轮询，将直接查询这些任务的状态。'
        ttk.Label(polling_frame, text=help_text, wraplength=700, font=('Arial', 9), foreground='gray').pack(anchor=tk.W, pady=5, fill=tk.X)

        # self.progress_var 在 __init__ 中初始化
        self.progress_frame = ttk.Frame(scrollable_frame) # 父容器改为 scrollable_frame
        self.progress_frame.pack(fill=tk.X, pady=5)
        ttk.Label(self.progress_frame, text='处理进度:').pack(side=tk.LEFT, padx=5)
        self.progress_bar = ttk.Progressbar(self.progress_frame, variable=self.progress_var, mode='determinate', length=600)
        self.progress_bar.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=5)
        self.progress_label = ttk.Label(self.progress_frame, text='0/0')
        self.progress_label.pack(side=tk.LEFT, padx=5)

        result_frame = ttk.LabelFrame(scrollable_frame, text='转写结果', padding='5') # 父容器改为 scrollable_frame
        result_frame.pack(fill=tk.BOTH, expand=True, pady=5)
        self.result_text = tk.Text(result_frame, height=10, width=70)
        self.result_text.pack(fill=tk.BOTH, expand=True)

        bottom_frame = ttk.Frame(scrollable_frame) # 父容器改为 scrollable_frame
        bottom_frame.pack(fill=tk.X, pady=5)
        ttk.Button(bottom_frame, text='保存结果', command=self._save_results).pack(side=tk.LEFT, padx=5)
        ttk.Button(bottom_frame, text='复制结果', command=self._copy_results).pack(side=tk.LEFT, padx=5)
        ttk.Button(bottom_frame, text='清空结果', command=self._clear_results).pack(side=tk.LEFT, padx=5)

    def _build_image_frame(self):
        """构建画面提界面"""
        input_frame = ttk.LabelFrame(self.image_frame, text='画面提取输入', padding='10')
        input_frame.pack(fill=tk.X, pady=5)
        input_frame.grid_columnconfigure(1, weight=1) # 让输入框随窗口拉伸

        # URL列表
        ttk.Label(input_frame, text='URL列表:').grid(column=0, row=0, sticky=tk.NW, padx=5, pady=5)
        self.image_url_text = tk.Text(input_frame, height=5, width=70)
        self.image_url_text.grid(column=1, row=0, sticky=tk.EW, padx=5, pady=5, columnspan=2)

        # 选择文件
        ttk.Label(input_frame, text='选择文件:').grid(column=0, row=1, sticky=tk.W, padx=5, pady=5)
        self.image_file_path = tk.StringVar()
        ttk.Entry(input_frame, textvariable=self.image_file_path, width=50).grid(column=1, row=1, sticky=tk.EW, padx=5, pady=5)
        ttk.Button(input_frame, text='浏览', command=self._browse_image_url_file).grid(column=2, row=1, sticky=tk.W, padx=5, pady=5)

        # 保存位置
        ttk.Label(input_frame, text='保存位置:').grid(column=0, row=2, sticky=tk.W, padx=5, pady=5)
        default_save_dir = os.path.join(os.path.expanduser('~'), 'Desktop', '画面提取结果')
        self.image_save_path = tk.StringVar(value=default_save_dir)
        ttk.Entry(input_frame, textvariable=self.image_save_path, width=50).grid(column=1, row=2, sticky=tk.EW, padx=5, pady=5)
        ttk.Button(input_frame, text='浏览', command=self._browse_image_save_path).grid(column=2, row=2, sticky=tk.W, padx=5, pady=5)

        # 并发数
        control_frame = ttk.Frame(input_frame)
        control_frame.grid(column=1, row=3, sticky=tk.W, padx=5, pady=5, columnspan=2)
        ttk.Label(control_frame, text='并发数:').pack(side=tk.LEFT, padx=5)
        self.image_concurrent = tk.IntVar(value=3)
        ttk.Spinbox(control_frame, from_=1, to=10, textvariable=self.image_concurrent, width=5).pack(side=tk.LEFT, padx=5)
        # 添加自动保存复选框
        self.image_auto_save = tk.BooleanVar(value=True)
        ttk.Checkbutton(control_frame, text='自动保存结果', variable=self.image_auto_save).pack(side=tk.LEFT, padx=15)

        # 添加提示词选择
        prompt_frame = ttk.Frame(input_frame)
        prompt_frame.grid(column=0, row=4, sticky=tk.W, padx=5, pady=5, columnspan=3)
        ttk.Label(prompt_frame, text='选择提示词:').pack(side=tk.LEFT, padx=5)
        self.selected_prompt_file = tk.StringVar()
        self.prompt_combobox = ttk.Combobox(prompt_frame, textvariable=self.selected_prompt_file, width=50, state="readonly")
        self.prompt_combobox.pack(side=tk.LEFT, padx=5, fill=tk.X, expand=True)
        # 添加刷新按钮
        refresh_button = ttk.Button(prompt_frame, text='刷新', width=5, command=self._load_prompt_files)
        refresh_button.pack(side=tk.LEFT, padx=5)
        
        # 按钮 - 确保在调用_load_prompt_files前创建按钮
        button_frame = ttk.Frame(self.image_frame)
        button_frame.pack(fill=tk.X, pady=10)
        self.start_image_button = ttk.Button(button_frame, text='开始提取', command=self._start_frame_extraction)
        self.start_image_button.pack(side=tk.LEFT, padx=5)
        self.stop_image_button = ttk.Button(button_frame, text='停止提取', command=self._stop_frame_extraction, state=tk.DISABLED)
        self.stop_image_button.pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text='清空输入', command=self._clear_image_input).pack(side=tk.LEFT, padx=5)

        # 现在按钮已创建，安全地加载提示词文件
        self._load_prompt_files()

        # 添加结果区域
        result_frame = ttk.LabelFrame(self.image_frame, text='提取结果', padding='5')
        result_frame.pack(fill=tk.BOTH, expand=True, pady=5)
        result_scroll = ttk.Scrollbar(result_frame)
        result_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.image_result_text = tk.Text(result_frame, height=10, width=70, yscrollcommand=result_scroll.set)
        self.image_result_text.pack(fill=tk.BOTH, expand=True)
        result_scroll.config(command=self.image_result_text.yview)
        
        # 添加底部按钮区域
        bottom_button_frame = ttk.Frame(self.image_frame)
        bottom_button_frame.pack(fill=tk.X, pady=5)
        ttk.Button(bottom_button_frame, text='保存JSON', command=self._save_image_results_as_json).pack(side=tk.LEFT, padx=5)
        ttk.Button(bottom_button_frame, text='复制结果', command=lambda: self._copy_text(self.image_result_text)).pack(side=tk.LEFT, padx=5)
        ttk.Button(bottom_button_frame, text='清空结果', command=lambda: self.image_result_text.delete(1.0, tk.END)).pack(side=tk.LEFT, padx=5)

    def _load_prompt_files(self):
        """扫描提示词目录并加载可用的提示词文件"""
        try:
            # 记住当前选中的值（如果有）
            current_selection = self.selected_prompt_file.get()
            
            # 确保提示词目录存在
            if not os.path.exists(self.PROMPT_DIR):
                os.makedirs(self.PROMPT_DIR)
                self.add_log(f"提示词目录不存在，已创建: {self.PROMPT_DIR}")
            
            # 扫描目录中的所有.txt文件
            prompt_files = []
            for file in os.listdir(self.PROMPT_DIR):
                if file.lower().endswith('.txt'):
                    prompt_files.append(file)
            
            # 更新下拉菜单
            if prompt_files:
                self.add_log(f"找到 {len(prompt_files)} 个提示词文件")
                self.prompt_combobox['values'] = prompt_files
                
                # 处理选择：如果之前有选择且仍在列表中，保持选择，否则选择第一个
                if current_selection and current_selection in prompt_files:
                    self.selected_prompt_file.set(current_selection)
                    self.add_log(f"保持当前选择: {current_selection}")
                else:
                    self.prompt_combobox.current(0)  # 默认选择第一个文件
                    self.add_log(f"已选择: {prompt_files[0]}")
                
                # 只有在按钮存在时设置其状态
                if hasattr(self, 'start_image_button'):
                    self.start_image_button.config(state=tk.NORMAL)
            else:
                self.add_log(f"未找到提示词文件，请在 {self.PROMPT_DIR} 目录中添加.txt文件")
                self.prompt_combobox['values'] = []
                self.selected_prompt_file.set("")  # 清空当前选择
                # 只有在按钮存在时设置其状态
                if hasattr(self, 'start_image_button'):
                    self.start_image_button.config(state=tk.DISABLED)
                    
        except Exception as e:
            error_msg = f"加载提示词文件时出错: {str(e)}"
            if hasattr(self, 'add_log'):
                self.add_log(error_msg)
            else:
                print(error_msg)  # 使用print作为备选
            
            # 只有在按钮存在时设置其状态
            if hasattr(self, 'start_image_button'):
                self.start_image_button.config(state=tk.DISABLED)
            
            # 显示错误消息（只在非初始化时）
            if hasattr(self, 'root') and self.root.winfo_exists():
                messagebox.showerror("错误", error_msg)

    def _browse_file(self):
        """浏览并选择文件"""
        file_path = filedialog.askopenfilename(title='选择URL文件', filetypes=[('文本文件', '*.txt'), ('JSON文件', '*.json'), ('所有文件', '*.*')])
        if file_path:
            self.file_path.set(file_path)
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                self.add_log(f'正在读取文件: {file_path}')
                try:
                    data = json.loads(content)
                    urls = []
                    if isinstance(data, list):
                        for item in data:
                            if isinstance(item, str) and ('http://' in item or 'https://' in item):
                                urls.append(item)
                            elif isinstance(item, dict):
                                for key, value in item.items():
                                    if isinstance(value, str) and ('http://' in value or 'https://' in value):
                                        urls.append(value)
                                        break
                    elif isinstance(data, dict):
                        for key, value in data.items():
                            if isinstance(value, str) and ('http://' in value or 'https://' in value):
                                urls.append(value)
                            elif isinstance(value, list):
                                for item in value:
                                    if isinstance(item, str) and ('http://' in item or 'https://' in item):
                                        urls.append(item)
                    if urls:
                        self.url_text.delete(1.0, tk.END)
                        self.url_text.insert(tk.END, '\n'.join(urls))
                        self.add_log(f'从JSON文件中提取了 {len(urls)} 个URL')
                    else:
                        lines = content.splitlines()
                        urls = [line.strip() for line in lines if 'http://' in line or 'https://' in line]
                        if urls:
                            self.url_text.delete(1.0, tk.END)
                            self.url_text.insert(tk.END, '\n'.join(urls))
                            self.add_log(f'从文件内容中提取了 {len(urls)} 个URL')
                except json.JSONDecodeError:
                    lines = content.splitlines()
                    urls = [line.strip() for line in lines if 'http://' in line or 'https://' in line]
                    if urls:
                        self.url_text.delete(1.0, tk.END)
                        self.url_text.insert(tk.END, '\n'.join(urls))
                        self.add_log(f'从文本文件中提取了 {len(urls)} 个URL')
                text_content = self.url_text.get(1.0, tk.END).strip()
                if text_content:
                    urls = text_content.splitlines()
                    unique_urls = []
                    for url in urls:
                        url = url.strip()
                        if url and url not in unique_urls and ('http://' in url or 'https://' in url):
                            unique_urls.append(url)
                    if len(unique_urls) < len(urls):
                        self.url_text.delete(1.0, tk.END)
                        self.url_text.insert(tk.END, '\n'.join(unique_urls))
                        self.add_log(f'删除了 {len(urls) - len(unique_urls)} 个重复URL，保留 {len(unique_urls)} 个')
            except Exception as e:
                messagebox.showerror('文件读取错误', str(e))

    def _start_processing(self):
        """开始处理视频"""
        # *** ADD CHECK: Prevent starting if already running ***
        if settings.RUNNING:
            self.add_log("任务已经在运行中，请勿重复启动。")
            return
        
        # Access global state variables via settings module
        urls = self._get_url_list()
        if not urls:
            messagebox.showinfo("提示", "请输入要处理的URL")
            return

        msg = f"将处理 {len(urls)} 个URL，是否继续？"
        if not messagebox.askyesno("确认", msg):
            return

        self.progress_var.set(0)
        # Modify global state via settings
        settings.COMPLETED_TASKS = 0 
        settings.TOTAL_TASKS = len(urls) 

        self.start_button.config(state=tk.DISABLED)
        self.stop_button.config(state=tk.NORMAL)

        self.result_text.delete(1.0, tk.END)

        # Clear global results via settings
        settings.RESULTS = [] 

        # Add URLs to the queue via settings
        for url in urls:
            settings.TASK_QUEUE.put(url) 

        # Set running flag via settings
        settings.RUNNING = True 

        try:
            concurrent = self.concurrent.get()
            concurrent = max(1, concurrent)
        except:
            concurrent = 3

        self.add_log(f"开始处理 {len(urls)} 个URL，并发数: {concurrent}")

        # Create and start the processing thread
        # Note: _process_thread will need to correctly handle asyncio loop creation
        self.thread = threading.Thread(target=self._process_thread, args=(concurrent,))
        self.thread.daemon = True
        self.thread.start()

    def _process_thread(self, concurrent):
        """处理线程函数"""
        try:
            if not hasattr(self, 'loop') or self.loop.is_closed():
                self.loop = asyncio.new_event_loop()
                asyncio.set_event_loop(self.loop)
            
            # Pass self (app instance) to worker
            workers = [asyncio.ensure_future(worker(self), loop=self.loop) for _ in range(concurrent)]
            
            # Run the workers. The thread will exit when gather returns.
            # Completion logic is now handled by _update_progress_ui based on task count.
            self.loop.run_until_complete(asyncio.gather(*workers))
            # *** REMOVE scheduling _processing_complete from here ***
            # self.root.after(100, self._processing_complete) 

        except Exception as e:
            error_msg = f"处理线程异常: {str(e)}"
            print(error_msg)
            traceback_info = traceback.format_exc()
            print(f"详细错误信息: {traceback_info}")
            # Use root.after to safely update log from thread
            self.root.after(0, lambda: self.add_log(error_msg)) 
            # *** Ensure completion logic runs even if thread errors out ***
            # Schedule the completion function to handle cleanup and UI update
            self.root.after(100, self._processing_complete) 

        finally:
            # Cleanup is still needed if the thread exits unexpectedly
            try:
                # Clean up loop resources
                # (Keep cancellation logic here for robustness in case of abnormal exit)
                pending = asyncio.all_tasks(self.loop) if hasattr(asyncio, 'all_tasks') else asyncio.Task.all_tasks(self.loop)
                for task in pending:
                     if not task.done(): # Check if task is done before cancelling
                          task.cancel()
                if pending:
                    # Allow cancellations to propagate
                    self.loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
                # No explicit loop closing needed, removed previously
            except Exception as e:
                print(f"清理事件循环时出错: {str(e)}")

            # 等待轮询线程处理完所有CF任务
            #self.add_log("画面提取管理线程 - 等待所有CF任务处理完成信号 (Event.wait())...")
            self.image_all_cf_tasks_processed.wait() # 等待绿灯
            #self.add_log("画面提取管理线程 - 收到所有CF任务处理完成信号 (Event is set)")

            # 任务完成后通知UI线程
            #self.add_log("准备调用_image_processing_complete...")
            self.root.after(0, self._image_processing_complete)
            self.add_log("画面提取管理线程结束")
        
    def _processing_complete(self):
        """处理完成后的操作 (Called when tasks are counted as complete, or on error/stop)"""
        # Set running flag to false
        settings.RUNNING = False

        # Update button states
        self.start_button.config(state=tk.NORMAL)
        self.stop_button.config(state=tk.DISABLED)
        
        # Add final summary log (check if needed, _add_task_summary might be called elsewhere)
        # self._add_task_summary() # This is already called by _update_progress_ui
        
        self.add_log("处理流程已完成或已停止。") # Generic completion message

        # Handle auto-saving
        if self.auto_save.get():
            if not settings.RESULTS:
                self.add_log("自动保存跳过：没有结果可保存。")
            else:
                # 1. 获取 UI 上的路径
                save_dir_from_ui = self.save_path.get()
                # 2. 清理空格
                potential_save_dir = save_dir_from_ui.strip()

                # 3. 判断路径是否为空
                if potential_save_dir:
                    # 不为空，使用用户指定的路径
                    final_save_dir = potential_save_dir
                    self.add_log(f"自动保存：使用用户指定路径: {final_save_dir}")
                else:
                    # 为空，使用默认路径
                    default_path = r'C:\Users\Administrator\Desktop\coze_api_data\text'
                    final_save_dir = default_path
                    self.add_log(f"自动保存：未指定路径，使用默认路径: {final_save_dir}")

                # 统一处理保存逻辑
                try:
                    # 确保目录存在
                    os.makedirs(final_save_dir, exist_ok=True)
                    saved_count = save_results_to_file(settings.RESULTS, final_save_dir)
                    self.add_log(f"处理完成，已自动保存 {saved_count} 个结果到 {final_save_dir}")
                    # 只有在成功保存后才显示带路径的消息框
                    messagebox.showinfo("处理完成",
                                        f"已完成 {settings.TOTAL_TASKS} 个URL的处理\n\n"
                                        f"已自动保存 {saved_count} 个结果到:\n"
                                        f"{final_save_dir}")
                except Exception as e:
                    error_msg = str(e)
                    self.add_log(f"自动保存结果失败: {error_msg}")
                    # 自动保存失败时，只显示错误消息，不提示手动保存
                    messagebox.showerror("自动保存失败",
                                            f"自动保存结果到 '{final_save_dir}' 失败:\n{error_msg}")
        # 如果没有勾选自动保存
        # 并且任务是自然完成（不是被停止）
        elif settings.COMPLETED_TASKS >= settings.TOTAL_TASKS:
            messagebox.showinfo("处理完成", f"已完成 {settings.TOTAL_TASKS} 个URL的处理")

    def _stop_processing(self):
        """停止处理"""
        self.add_log("收到停止请求...")
        # Access global state via settings
        settings.RUNNING = False 

        self.add_log("正在清空任务队列...")
        # Clear queue via settings.TASK_QUEUE
        cleared_count = 0
        while not settings.TASK_QUEUE.empty(): 
            try:
                settings.TASK_QUEUE.get_nowait()
                settings.TASK_QUEUE.task_done()
                cleared_count += 1
            except queue.Empty:
                break
        self.add_log(f"已从队列中移除 {cleared_count} 个待处理任务。")
        
        # Note: Explicit task cancellation removed to follow original logic
        # Background workers will stop based on checking settings.RUNNING
        
        self.add_log("已请求停止所有任务 (通过设置RUNNING=False)")
        
        # Immediately update button states after requesting stop
        self.start_button.config(state=tk.NORMAL) 
        self.stop_button.config(state=tk.DISABLED)
        
        # Log remaining tasks (optional, can be noisy if stop is immediate)
        # remaining = settings.TOTAL_TASKS - settings.COMPLETED_TASKS 
        # if remaining > 0:
        #     self.add_log(f"有 {remaining} 个任务可能未完成或正在停止中。")
        
        # No longer need a delay, buttons are updated immediately.
        # self.root.after(1000, lambda: self.start_button.config(state=tk.NORMAL))
        
    def _clear_logs(self):
        """清空日志"""
        self.log_text.configure(state="normal")
        self.log_text.delete(1.0, tk.END)
        self.log_text.configure(state="disabled")

    def _save_results(self):
        """保存结果"""
        if not settings.RESULTS:
            messagebox.showinfo("提示", "没有可保存的结果")
            return

        # 1. 获取 UI 上的路径
        save_dir_from_ui = self.save_path.get()
        # 2. 清理空格
        potential_save_dir = save_dir_from_ui.strip()

        # 3. 判断路径是否为空
        if potential_save_dir:
            # 不为空，使用用户指定的路径
            final_save_dir = potential_save_dir
            self.add_log(f"手动保存：使用用户指定路径: {final_save_dir}")
        else:
            # 为空，使用默认路径
            default_path = r'C:\Users\Administrator\Desktop\coze_api_data\text'
            final_save_dir = default_path
            self.add_log(f"手动保存：未指定路径，使用默认路径: {final_save_dir}")

        try:
            # 确保目录存在
            os.makedirs(final_save_dir, exist_ok=True)
            saved_count = save_results_to_file(settings.RESULTS, final_save_dir)
            self.add_log(f'手动保存 {saved_count} 个结果到 {final_save_dir}')
            messagebox.showinfo("成功", f"已将 {saved_count} 个结果保存到 {final_save_dir}")
        except Exception as e:
            self.add_log(f"手动保存结果失败: {str(e)}")
            messagebox.showerror("保存失败", str(e))

    def _copy_results(self):
        """复制结果到剪贴板"""
        result_text = self.result_text.get(1.0, tk.END)
        if result_text.strip():
            self.root.clipboard_clear()
            self.root.clipboard_append(result_text)
            messagebox.showinfo('成功', '结果已复制到剪贴板')
        else:
            messagebox.showinfo('提示', '没有可复制的结果')

    def _save_settings(self):
        """保存设置"""
        # Use .get() to retrieve value from tk.StringVar and save to settings
        settings.API_KEY = self.api_key.get() 
        messagebox.showinfo("成功", "设置已保存")

    def add_log(self, message):
        """添加日志"""
        current_time = time.strftime('%H:%M:%S')
        log_message = f'[{current_time}] {message}\n'
        self.root.after(0, lambda: self._update_log(log_message))

    def _update_log(self, message):
        """更新日志UI（在主线程中调用）"""
        try:
            # 检查是否包含API来源信息，添加不同颜色标记
            if "使用山海云端API" in message:
                message = message.replace("使用山海云端API", "使用<备用API:山海云端>")
                self.log_text.configure(state="normal")
                self.log_text.insert("end", message, "api_backup")
                self.log_text.tag_configure("api_backup", foreground="#FF6600")
            else:
                self.log_text.configure(state="normal")
                self.log_text.insert("end", message)
            self.log_text.configure(state="disabled")
            self.log_text.see("end")
        except Exception as e:
            print(f"更新日志UI出错: {str(e)}")

    def add_result(self, result):
        """添加结果"""
        self.root.after(0, lambda: self._update_result(result))

    def _update_result(self, result):
        """更新结果（在主线程中调用）"""
        self.result_text.insert(tk.END, result)
        self.result_text.see(tk.END)

    def update_progress(self):
        """更新进度"""
        # Access global state via settings
        if settings.TOTAL_TASKS > 0: 
            progress = (settings.COMPLETED_TASKS / settings.TOTAL_TASKS) * 100 
            self.root.after(0, lambda: self._update_progress_ui(progress))

    def _update_progress_ui(self, progress):
        """更新进度UI（在主线程中调用）"""
        # Access global state via settings
        self.progress_var.set(progress)
        self.progress_label.config(text=f"{settings.COMPLETED_TASKS}/{settings.TOTAL_TASKS}") 
        
        # Check completion using settings variables
        if settings.COMPLETED_TASKS >= settings.TOTAL_TASKS: 
            # *** Call _processing_complete directly when task count indicates completion ***
            self.add_log("所有任务已计数完成，执行最终处理...") 
            self._add_task_summary() # Log summary first
            self._processing_complete() # Then call the main completion logic
            # No need to update buttons here, _processing_complete handles it
            # self.start_button.config(state=tk.NORMAL)
            # self.stop_button.config(state=tk.DISABLED)
            # self.add_log("所有任务已完成") # Message now in _processing_complete
            
            # Logic for auto-saving moved to _processing_complete
            # ...

    def _add_task_summary(self):
        """添加任务执行总结信息"""
        # Access global state via settings
        successful_urls = []
        failed_details = []
        processed_urls = set()
        
        # Iterate through settings.RESULTS
        for result in settings.RESULTS: 
            original_url = result.get("originalUrl", result.get("videoUrl", ""))
            if original_url not in processed_urls:
                processed_urls.add(original_url)
                if result.get("completed", False) and result.get("text") and len(result.get("text", "").strip()) > 0:
                    successful_urls.append(original_url)
                else:
                    task_id = result.get("taskId", "未知")
                    error_msg = result.get("message", "未知错误")
                    failed_details.append({
                        "url": original_url,
                        "taskId": task_id,
                        "message": error_msg
                    })
        
        summary = "\n" + "="*50 + "\n"
        summary += "【任务执行总结】\n"
        # Access settings.TOTAL_TASKS
        summary += f"总URL数: {settings.TOTAL_TASKS}\n" 
        summary += f"成功数量: {len(successful_urls)}\n"
        summary += f"失败数量: {len(failed_details)}\n"
        
        if successful_urls:
            summary += "\n成功转写的URL:\n"
            for i, url in enumerate(successful_urls):
                summary += f"{i+1}. {url}\n"
        
        if failed_details:
            summary += "\n转写失败的URL (包含taskId):\n"
            for i, detail in enumerate(failed_details):
                summary += f"{i+1}. {detail['url']}\n   - TaskID: {detail['taskId']}\n   - 错误: {detail['message']}\n"
        
        summary += "="*50 + "\n"
        self.add_log(summary)
        self.add_result("\n" + summary)

    def _get_url_list(self):
        """获取URL列表"""
        content = self.url_text.get(1.0, tk.END).strip()
        if not content:
            file_path = self.file_path.get()
            if file_path and os.path.exists(file_path):
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        content = f.read().strip()
                except Exception as e:
                    self.add_log(f'读取文件失败: {str(e)}')
                    return []
        lines = content.splitlines()
        processed_lines = []
        for line in lines:
            line = line.strip()
            if not line:
                continue
            if '抖音' in line or 'douyin' in line.lower() or 'ixigua' in line.lower() or ('tiktok' in line.lower()):
                clean_url = extract_douyin_link_from_text(line)
                if clean_url != line:
                    self.add_log(f'已清理抖音分享文本: {line} -> {clean_url}')
                processed_lines.append(clean_url)
            else:
                processed_lines.append(line)
        unique_urls = []
        for url in processed_lines:
            if ('http://' in url or 'https://' in url) and url not in unique_urls:
                unique_urls.append(url)
        if len(unique_urls) < len(processed_lines):
            self.add_log(f'已过滤 {len(processed_lines) - len(unique_urls)} 个无效或重复URL，保留 {len(unique_urls)} 个有效URL')
        if len(unique_urls) > 0 and len(unique_urls) != len(lines):
            self.url_text.delete(1.0, tk.END)
            self.url_text.insert(tk.END, '\n'.join(unique_urls))
        return unique_urls

    def _browse_save_dir(self):
        """浏览并选择保存目录"""
        save_dir = filedialog.askdirectory(title='选择结果保存目录', initialdir=self.save_path.get())
        if save_dir:
            self.save_path.set(save_dir)
            self.add_log(f'已设置保存目录: {save_dir}')
            try:
                os.makedirs(save_dir, exist_ok=True)
            except Exception as e:
                messagebox.showerror('错误', f'创建目录失败: {str(e)}')

    def _build_log_frame(self):
        """构建运行日志界面"""
        log_scroll = ttk.Scrollbar(self.log_frame)
        log_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.log_text = tk.Text(self.log_frame, height=20, width=70, yscrollcommand=log_scroll.set)
        self.log_text.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)
        log_scroll.config(command=self.log_text.yview)
        button_frame = ttk.Frame(self.log_frame)
        button_frame.pack(fill=tk.X, pady=5)
        ttk.Button(button_frame, text='清空日志', command=self._clear_logs).pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text='导出日志', command=self._export_logs).pack(side=tk.LEFT, padx=5)

    def _build_results_frame(self):
        """构建转写结果界面"""
        result_scroll = ttk.Scrollbar(self.results_frame)
        result_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.result_text = tk.Text(self.results_frame, height=20, width=70, yscrollcommand=result_scroll.set)
        self.result_text.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)
        result_scroll.config(command=self.result_text.yview)
        button_frame = ttk.Frame(self.results_frame)
        button_frame.pack(fill=tk.X, pady=5)
        ttk.Button(button_frame, text='保存结果', command=self._save_results).pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text='复制结果', command=self._copy_results).pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text='清空结果', command=self._clear_results).pack(side=tk.LEFT, padx=5)

    def _export_logs(self):
        """导出日志"""
        file_path = filedialog.asksaveasfilename(title='保存日志', defaultextension='.txt', filetypes=[('文本文件', '*.txt')])
        if not file_path:
            return
        try:
            with open(file_path, 'w', encoding='utf-8') as f:
                log_text = self.log_text.get(1.0, tk.END)
                f.write(log_text)
            messagebox.showinfo('成功', f'日志已保存到 {file_path}')
        except Exception as e:
            messagebox.showerror('保存失败', str(e))

    def _clear_results(self):
        """清空结果"""
        self.result_text.delete(1.0, tk.END)

    def _browse_poll_file(self):
        """浏览并选择任务ID文件"""
        file_path = filedialog.askopenfilename(title='选择任务ID文件', filetypes=[('文本文件', '*.txt'), ('所有文件', '*.*')])
        if file_path:
            self.taskid_file_path.set(file_path)
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                self.taskid_text.delete(1.0, tk.END)
                self.taskid_text.insert(tk.END, content)
                self.add_log(f'成功加载任务ID文件: {file_path}')
            except Exception as e:
                self.add_log(f'读取任务ID文件失败: {str(e)}')
                messagebox.showerror('文件读取错误', str(e))

    def _browse_poll_save_dir(self):
        """浏览并选择轮询结果保存目录"""
        save_dir = filedialog.askdirectory(title='选择保存目录')
        if save_dir:
            self.poll_save_path.set(save_dir)

    def _start_polling_by_taskid(self):
        """根据任务ID列表开始轮询"""
        taskid_text = self.taskid_text.get(1.0, tk.END).strip()
        if not taskid_text:
            messagebox.showwarning('警告', '请输入至少一个任务ID')
            return
        taskids = []
        for line in taskid_text.split('\n'):
            line = line.strip()
            if line:
                taskids.append(line)
        if not taskids:
            messagebox.showwarning('警告', '没有有效的任务ID')
            return
        self.poll_button.configure(state=tk.DISABLED)
        self.stop_poll_button.configure(state=tk.NORMAL)
        self.progress_var.set(0)
        self.progress_label.configure(text=f'0/{len(taskids)}')
        self.result_text.delete(1.0, tk.END)
        self.add_log(f'开始轮询 {len(taskids)} 个任务')
        concurrent = self.poll_concurrent.get()
        max_polling = self.poll_max_polling.get()
        auto_save = self.poll_auto_save.get()
        save_path = self.poll_save_path.get()
        threading.Thread(target=self._run_polling_tasks, args=(taskids, concurrent, max_polling, auto_save, save_path), daemon=True).start()

    def _run_polling_tasks(self, taskids, concurrent, max_polling, auto_save, save_path):
        """在后台运行轮询任务"""
        # This runs in a separate thread and manages its own async loop.
        # It *might* need to interact with settings.RUNNING if the global stop should affect it.
        # Let's assume it uses its own RUNNING or accesses settings.RUNNING correctly for now.
        # It modifies global RESULTS. Needs update.
        try:
            # Assuming this flow needs the main RUNNING flag
            settings.RUNNING = True 
            settings.TOTAL_TASKS = len(taskids) 
            settings.COMPLETED_TASKS = 0 
            settings.RESULTS = [] # Reset RESULTS for polling task
            
            task_queue = queue.Queue()
            for taskid in taskids:
                task_queue.put(taskid)
            
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            
            tasks = []
            for _ in range(min(concurrent, settings.TOTAL_TASKS)):
                # _poll_worker needs access to settings
                tasks.append(loop.create_task(self._poll_worker(task_queue, max_polling)))
            
            loop.run_until_complete(asyncio.gather(*tasks))
            self.root.after(0, self._polling_complete, auto_save, save_path)
            
        except Exception as e:
            self.root.after(0, lambda: self.add_log(f"轮询过程出错: {str(e)}"))
        finally:
            # Reset RUNNING if this flow manages it independently? Or assume main stop handles it.
            settings.RUNNING = False # Assume this flow resets RUNNING when done

    async def _poll_worker(self, task_queue, max_polling):
        # This runs within the _run_polling_tasks loop.
        # Needs access to settings.RUNNING, settings.RESULTS, settings.COMPLETED_TASKS
        while not task_queue.empty() and settings.RUNNING: # Use settings.RUNNING
            try:
                taskid = task_queue.get_nowait()
                self.root.after(0, lambda tid=taskid: self.add_log(f"开始轮询任务: {tid}"))
                
                # _poll_task_by_id needs access to settings (e.g., API_KEY)
                result = await self._poll_task_by_id(taskid, max_polling)
                
                if result.get("success") and result.get("completed"):
                    text = result.get("text", "")
                    if text and len(text.strip()) > 0:
                        self.root.after(0, lambda tid=taskid, t=text: self._update_poll_result(tid, t))
                        # Append to settings.RESULTS
                        result["videoUrl"] = f"taskId:{taskid}"
                        result["originalUrl"] = f"taskId:{taskid}"
                        settings.RESULTS.append(result) 
                    else:
                        self.root.after(0, lambda tid=taskid: self.add_log(f"警告: {tid} - 任务完成但结果为空"))
                else:
                    error_msg = result.get('message', '未知错误')
                    self.root.after(0, lambda tid=taskid, msg=error_msg: self.add_log(f"轮询失败: {tid} - {msg}"))
                
                # Update settings.COMPLETED_TASKS
                settings.COMPLETED_TASKS += 1 
                progress = (settings.COMPLETED_TASKS / settings.TOTAL_TASKS) * 100
                self.root.after(0, lambda p=progress: self.progress_var.set(p))
                self.root.after(0, lambda: self.progress_label.configure(text=f"{settings.COMPLETED_TASKS}/{settings.TOTAL_TASKS}"))
                
            except queue.Empty:
                break
            except Exception as e:
                self.root.after(0, lambda err=str(e): self.add_log(f'轮询工作线程错误: {err}'))

    async def _poll_task_by_id(self, taskid, max_polling=10):
        """轮询单个任务状态"""
        url = f'https://dashscope.aliyuncs.com/api/v1/tasks/{taskid}'
        api_key = 'sk-c9ff063db3ee481dbea6846c29fb8ec0'
        polling_count = 0
        last_status = ''
        while True:
            try:
                start_time = time.time()
                headers = {'Authorization': f'Bearer {api_key}', 'Accept': 'application/json'}
                import aiohttp
                async with aiohttp.ClientSession() as session:
                    start_time = time.time()
                    async with session.get(url, headers=headers) as response:
                        end_time = time.time()
                        response_time = round((end_time - start_time) * 1000)
                        if response.status != 200:
                            try:
                                error_data = await response.json()
                                error_message = error_data.get('message', f'HTTP错误 {response.status}')
                                error_log = f'轮询任务 {taskid} 失败: {error_message}'
                                self.root.after(0, lambda msg=error_log: self.add_log(msg))
                                return {'success': False, 'message': f'查询任务异常: {error_message}', 'taskId': taskid, 'completed': False}
                            except:
                                error_log = f'轮询任务 {taskid} 失败: HTTP {response.status}'
                                self.root.after(0, lambda msg=error_log: self.add_log(msg))
                                return {'success': False, 'message': f'查询任务异常: HTTP {response.status}', 'taskId': taskid, 'completed': False}
                        result = await response.json()
                        log_msg = f'查询任务 {taskid} 成功'
                        self.root.after(0, lambda msg=log_msg: self.add_log(msg))
                        task_status = None
                        if 'output' in result and 'task_status' in result['output']:
                            task_status = result['output']['task_status']
                        elif 'Data' in result and 'Status' in result['Data']:
                            task_status = result['Data']['Status']
                        elif 'status' in result:
                            task_status = result['status']
                        elif 'Status' in result:
                            task_status = result['Status']
                        if task_status is None:
                            error_log = f'任务 {taskid} 无法获取状态'
                            self.root.after(0, lambda msg=error_log: self.add_log(msg))
                            return {'success': False, 'message': '无法从响应中获取任务状态', 'taskId': taskid, 'completed': False, 'rawResponse': json.dumps(result)[:500]}
                        is_completed = task_status in ['SUCCEEDED', 'COMPLETED', 'SUCCESS', 'FAILED', 'ERROR'] or task_status in [200, 500, 400]
                        result_data = None
                        if 'output' in result and 'result' in result['output']:
                            result_data = result['output']['result']
                        elif 'output' in result and 'results' in result['output']:
                            result_data = result['output']['results']
                        elif 'Data' in result and 'Results' in result['Data']:
                            result_data = result['Data']['Results']
                        elif 'Data' in result and 'Result' in result['Data']:
                            result_data = result['Data']['Result']
                        elif 'result' in result:
                            result_data = result['result']
                        elif 'results' in result:
                            result_data = result['results']
                        if task_status in ['SUCCEEDED', 'COMPLETED', 'SUCCESS'] or task_status == 200:
                            result_text = extract_text(result_data) if result_data else ''
                            if isinstance(result_text, str) and result_text and ('transcription_url' in result_text):
                                try:
                                    result_json = json.loads(result_text)
                                    if 'transcription_url' in result_json:
                                        transcription_url = result_json['transcription_url']
                                        try:
                                            async with session.get(transcription_url, headers={'Accept': 'application/json, text/plain, */*'}) as transcription_response:
                                                if transcription_response.status == 200:
                                                    transcription_data = await transcription_response.text()
                                                    try:
                                                        transcription_json = json.loads(transcription_data)
                                                        if 'transcripts' in transcription_json and isinstance(transcription_json['transcripts'], list):
                                                            texts_from_transcripts = []
                                                            for transcript in transcription_json['transcripts']:
                                                                text = transcript.get('text', '')
                                                                if text:
                                                                    texts_from_transcripts.append(text)
                                                            if texts_from_transcripts:
                                                                result_text = '\n'.join(texts_from_transcripts)
                                                    except Exception as e:
                                                        result_text = transcription_data
                                        except Exception as e:
                                            error_log = f'获取转录内容失败: {taskid} - {str(e)}'
                                            self.root.after(0, lambda msg=error_log: self.add_log(msg))
                                except Exception as e:
                                    error_log = f'解析transcription_url失败: {taskid} - {str(e)}'
                                    self.root.after(0, lambda msg=error_log: self.add_log(msg))
                            success_log = f'轮询成功: {taskid} - 已完成转写'
                            self.root.after(0, lambda msg=success_log: self.add_log(msg))
                            return {'success': True, 'message': '任务已完成', 'status': task_status, 'text': result_text, 'taskId': taskid, 'completed': True}
                        elif task_status in ['FAILED', 'ERROR'] or task_status in [500, 400]:
                            error_message = '未知错误'
                            if 'output' in result and 'error' in result['output']:
                                error_message = result['output']['error'].get('message', '未知错误')
                            elif 'Error' in result and 'Message' in result['Error']:
                                error_message = result['Error']['Message']
                            return {'success': False, 'message': f'任务失败: {error_message}', 'status': task_status, 'taskId': taskid, 'completed': False, 'rawResponse': json.dumps(result, ensure_ascii=False, indent=2)}
                        else:
                            last_status = task_status
                            polling_count += 1
                            status_log = f'任务 {taskid} 状态: {task_status} (第 {polling_count} 次轮询)'
                            self.root.after(0, lambda msg=status_log: self.add_log(msg))
                            if task_status != 'RUNNING' and polling_count >= max_polling:
                                return {'success': False, 'message': f'已达到最大轮询次数({max_polling})，任务仍未完成', 'status': task_status, 'taskId': taskid, 'completed': False}
                            await asyncio.sleep(5)
            except asyncio.CancelledError:
                return {'success': False, 'message': '轮询操作被取消', 'taskId': taskid, 'completed': False}
            except Exception as e:
                error_detail = traceback.format_exc()
                error_log = f'轮询任务 {taskid} 出错: {str(e)}'
                self.root.after(0, lambda msg=error_log: self.add_log(msg))
                polling_count += 1
                if polling_count >= max_polling:
                    return {'success': False, 'message': f'轮询过程中出错: {str(e)}', 'error_detail': error_detail, 'taskId': taskid, 'completed': False}
                await asyncio.sleep(3)

    def _update_poll_result(self, taskid, text):
        """更新结果区域"""
        self.add_log(f'轮询成功: {taskid} - 已完成转写')
        self.add_result(f'taskId: {taskid}\n{text}\n\n')

    def _polling_complete(self, auto_save, save_path):
        """轮询完成后的操作"""
        # Access global state via settings
        self.add_log(f"所有轮询任务完成 ({settings.COMPLETED_TASKS}/{settings.TOTAL_TASKS})") 
        self.poll_button.configure(state=tk.NORMAL)
        self.stop_poll_button.configure(state=tk.DISABLED)
        # Use settings.RESULTS here
        if auto_save and settings.RESULTS: 
            try:
                os.makedirs(save_path, exist_ok=True)
                timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
                save_file = os.path.join(save_path, f'polling_results_{timestamp}.json')
                formatted_results = []
                # Use settings.RESULTS here
                for result in settings.RESULTS: 
                    taskid = result.get('taskId', '')
                    text = result.get('text', '')
                    formatted_result = {'message': text, 'url': result.get('originalUrl', ''), 'title': result.get('title', '未知标题'), 'videoUrl': result.get('videoUrl', ''), 'taskId': taskid, 'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
                    formatted_results.append(formatted_result)
                with open(save_file, 'w', encoding='utf-8') as f:
                    json.dump(formatted_results, f, ensure_ascii=False, indent=2)
                self.add_log(f'结果已自动保存到: {save_file}')
            except Exception as e:
                self.add_log(f'自动保存结果失败: {str(e)}')

    def _stop_polling(self):
        """停止任务轮询"""
        # Use settings.RUNNING
        settings.RUNNING = False 
        self.add_log('正在停止轮询...')
        self.poll_button.configure(state=tk.NORMAL)
        self.stop_poll_button.configure(state=tk.DISABLED)

    def _clear_taskids(self):
        """清空任务ID输入区域"""
        self.taskid_text.delete(1.0, tk.END)
        self.taskid_file_path.set('')

    def _build_settings_frame(self):
        """构建设置界面"""
        # API设置
        api_frame = ttk.LabelFrame(self.settings_frame, text="API设置", padding="10")
        api_frame.pack(fill=tk.X, pady=10)
        
        ttk.Label(api_frame, text="热点火花阿里API密钥:").grid(column=0, row=0, sticky=tk.W, padx=5, pady=5)
        # Restore using tk.StringVar for API key entry
        self.api_key = tk.StringVar(value=settings.API_KEY) 
        self.api_key_entry = ttk.Entry(api_frame, textvariable=self.api_key, width=60)
        self.api_key_entry.grid(column=1, row=0, sticky=tk.EW, padx=5, pady=5)
        
        # Use grid for the save button
        save_button = ttk.Button(api_frame, text="保存设置", command=self._save_settings)
        save_button.grid(column=1, row=1, sticky=tk.E, padx=5, pady=10)

        # Configure column weights for proper resizing if needed
        api_frame.grid_columnconfigure(1, weight=1) 

        about_frame = ttk.LabelFrame(self.settings_frame, text='关于', padding='10')
        about_frame.pack(fill=tk.X, pady=10)
        about_text = '热点火花收集工具\n\n'
        about_text += '本工具使用阿里云热点火花API将视频内容转写为文字。\n'
        about_text += '支持多URL批量处理，可同时处理多个视频。\n\n'
        about_text += '作者: jacky\n'
        about_text += '版本: 1.0.0'
        about_label = ttk.Label(about_frame, text=about_text, justify=tk.LEFT)
        about_label.pack(padx=5, pady=5)

    def _build_url_parser_frame(self):
        """构建链接解析界面"""
        title_frame = ttk.Frame(self.url_parser_frame, padding='5')
        title_frame.pack(fill=tk.X, pady=5)
        ttk.Label(title_frame, text='抖音视频链接解析', font=('Arial', 12, 'bold')).pack(anchor=tk.W, padx=5, pady=5)
        ttk.Label(title_frame, text='用于解析抖音等平台的视频链接，获取直接可播放的视频地址').pack(anchor=tk.W, padx=5)
        input_frame = ttk.LabelFrame(self.url_parser_frame, text='输入区域', padding='10')
        input_frame.pack(fill=tk.X, pady=5)
        ttk.Label(input_frame, text='视频链接:').grid(column=0, row=0, sticky=tk.W, padx=5, pady=5)
        self.parser_url_text = tk.Text(input_frame, height=5, width=70)
        self.parser_url_text.grid(column=0, row=1, sticky=tk.EW, padx=5, pady=5, columnspan=2)
        ttk.Label(input_frame, text='从文件导入:').grid(column=0, row=2, sticky=tk.W, padx=5, pady=5)
        self.parser_file_path = tk.StringVar()
        ttk.Entry(input_frame, textvariable=self.parser_file_path, width=50).grid(column=0, row=3, sticky=tk.EW, padx=5, pady=5)
        ttk.Button(input_frame, text='浏览', command=self._browse_parser_file).grid(column=1, row=3, sticky=tk.W, padx=5, pady=5)
        ttk.Label(input_frame, text='保存位置:').grid(column=0, row=4, sticky=tk.W, padx=5, pady=5)
        self.parser_save_path = tk.StringVar(value='C:\\Users\\53246\\Desktop\\解析结果')
        ttk.Entry(input_frame, textvariable=self.parser_save_path, width=50).grid(column=0, row=5, sticky=tk.EW, padx=5, pady=5)
        ttk.Button(input_frame, text='浏览', command=self._browse_parser_save_dir).grid(column=1, row=5, sticky=tk.W, padx=5, pady=5)
        ttk.Label(input_frame, text='并发数量:').grid(column=0, row=6, sticky=tk.W, padx=5, pady=5)
        control_frame = ttk.Frame(input_frame)
        control_frame.grid(column=1, row=6, sticky=tk.W, padx=5, pady=5)
        self.parser_concurrent = tk.IntVar(value=3)
        ttk.Spinbox(control_frame, from_=1, to=10, textvariable=self.parser_concurrent, width=5).pack(side=tk.LEFT, padx=5)
        # 添加自动保存复选框
        self.parser_auto_save = tk.BooleanVar(value=False) # 默认不勾选
        ttk.Checkbutton(control_frame, text='自动保存结果', variable=self.parser_auto_save).pack(side=tk.LEFT, padx=15)
        button_frame = ttk.Frame(self.url_parser_frame)
        button_frame.pack(fill=tk.X, pady=10)
        self.parse_button = ttk.Button(button_frame, text='开始解析', command=self._start_parsing)
        self.parse_button.pack(side=tk.LEFT, padx=5)
        self.stop_parse_button = ttk.Button(button_frame, text='停止解析', command=self._stop_parsing, state=tk.DISABLED)
        self.stop_parse_button.pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text='清空输入', command=self._clear_parser_input).pack(side=tk.LEFT, padx=5)
        self.parser_progress_var = tk.DoubleVar(value=0)
        self.parser_progress_frame = ttk.Frame(self.url_parser_frame)
        self.parser_progress_frame.pack(fill=tk.X, pady=5)
        ttk.Label(self.parser_progress_frame, text='解析进度:').pack(side=tk.LEFT, padx=5)
        self.parser_progress_bar = ttk.Progressbar(self.parser_progress_frame, variable=self.parser_progress_var, mode='determinate', length=600)
        self.parser_progress_bar.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=5)
        self.parser_progress_label = ttk.Label(self.parser_progress_frame, text='0/0')
        self.parser_progress_label.pack(side=tk.LEFT, padx=5)
        result_frame = ttk.LabelFrame(self.url_parser_frame, text='解析结果', padding='5')
        result_frame.pack(fill=tk.BOTH, expand=True, pady=5)
        self.parser_result_text = tk.Text(result_frame, height=10, width=70)
        self.parser_result_text.pack(fill=tk.BOTH, expand=True)
        bottom_frame = ttk.Frame(self.url_parser_frame)
        bottom_frame.pack(fill=tk.X, pady=5)
        ttk.Button(bottom_frame, text='保存结果', command=self._save_parser_results).pack(side=tk.LEFT, padx=5)
        ttk.Button(bottom_frame, text='复制结果', command=self._copy_parser_results).pack(side=tk.LEFT, padx=5)
        ttk.Button(bottom_frame, text='清空结果', command=self._clear_parser_results).pack(side=tk.LEFT, padx=5)

    def _browse_parser_file(self):
        """浏览并选择链接文件"""
        file_path = filedialog.askopenfilename(title='选择链接文件', filetypes=[('文本文件', '*.txt'), ('JSON文件', '*.json'), ('所有文件', '*.*')])
        if file_path:
            self.parser_file_path.set(file_path)
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                self.add_log(f'正在读取文件: {file_path}')
                urls = []
                try:
                    data = json.loads(content)
                    if isinstance(data, list):
                        for item in data:
                            if isinstance(item, str) and ('http://' in item or 'https://' in item):
                                urls.append(item)
                            elif isinstance(item, dict):
                                for key, value in item.items():
                                    if isinstance(value, str) and ('http://' in value or 'https://' in value):
                                        urls.append(value)
                                        break
                    elif isinstance(data, dict):
                        for key, value in data.items():
                            if isinstance(value, str) and ('http://' in value or 'https://' in value):
                                urls.append(value)
                            elif isinstance(value, list):
                                for item in value:
                                    if isinstance(item, str) and ('http://' in item or 'https://' in item):
                                        urls.append(item)
                except json.JSONDecodeError:
                    lines = content.splitlines()
                    for line in lines:
                        line = line.strip()
                        if 'http://' in line or 'https://' in line:
                            if '抖音' in line or 'douyin' in line.lower():
                                clean_url = extract_douyin_link_from_text(line)
                                urls.append(clean_url)
                            else:
                                urls.append(line)
                unique_urls = []
                for url in urls:
                    if url and url not in unique_urls:
                        unique_urls.append(url)
                if unique_urls:
                    self.parser_url_text.delete(1.0, tk.END)
                    self.parser_url_text.insert(tk.END, '\n'.join(unique_urls))
                    self.add_log(f'从文件中提取了 {len(unique_urls)} 个URL')
                else:
                    self.add_log('文件中未找到有效URL')
                    messagebox.showinfo('提示', '文件中未找到有效URL')
            except Exception as e:
                self.add_log(f'读取文件失败: {str(e)}')
                messagebox.showerror('文件读取错误', str(e))

    def _browse_parser_save_dir(self):
        """浏览并选择链接解析结果保存目录"""
        save_dir = filedialog.askdirectory(title='选择结果保存目录', initialdir=self.parser_save_path.get())
        if save_dir:
            self.parser_save_path.set(save_dir)
            self.add_log(f'已设置解析结果保存目录: {save_dir}')
            try:
                os.makedirs(save_dir, exist_ok=True)
            except Exception as e:
                messagebox.showerror('错误', f'创建目录失败: {str(e)}')

    def _clear_parser_input(self):
        """清空链接解析输入"""
        self.parser_url_text.delete(1.0, tk.END)
        self.parser_file_path.set('')

    def _clear_parser_results(self):
        """清空链接解析结果"""
        self.parser_result_text.delete(1.0, tk.END)

    def _copy_parser_results(self):
        """复制链接解析结果到剪贴板"""
        result_text = self.parser_result_text.get(1.0, tk.END)
        if result_text.strip():
            self.root.clipboard_clear()
            self.root.clipboard_append(result_text)
            messagebox.showinfo('成功', '结果已复制到剪贴板')
        else:
            messagebox.showinfo('提示', '没有可复制的结果')

    def _save_parser_results(self):
        """保存链接解析结果"""
        result_text = self.parser_result_text.get(1.0, tk.END).strip()
        if not result_text:
            messagebox.showinfo('提示', '没有可保存的结果')
            return
        save_dir = self.parser_save_path.get()
        if not save_dir:
            save_dir = 'C:\\Users\\53246\\Desktop\\解析结果'
        try:
            os.makedirs(save_dir, exist_ok=True)
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            file_path = os.path.join(save_dir, f'url_parser_results_{timestamp}.txt')
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(result_text)
            self.add_log(f'解析结果已保存到: {file_path}')
            messagebox.showinfo('成功', f'结果已保存到:\n{file_path}')
        except Exception as e:
            self.add_log(f'保存结果失败: {str(e)}')
            messagebox.showerror('保存失败', str(e))

    def _get_parser_url_list(self):
        """获取要解析的URL列表"""
        content = self.parser_url_text.get(1.0, tk.END).strip()
        if not content:
            file_path = self.parser_file_path.get()
            if file_path and os.path.exists(file_path):
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        content = f.read().strip()
                except Exception as e:
                    self.add_log(f'读取文件失败: {str(e)}')
                    return []
        lines = content.splitlines()
        processed_lines = []
        for line in lines:
            line = line.strip()
            if not line:
                continue
            if '抖音' in line or 'douyin' in line.lower() or 'ixigua' in line.lower() or ('tiktok' in line.lower()):
                clean_url = extract_douyin_link_from_text(line)
                if clean_url != line:
                    self.add_log(f'已清理抖音分享文本: {line} -> {clean_url}')
                processed_lines.append(clean_url)
            else:
                processed_lines.append(line)
        unique_urls = []
        for url in processed_lines:
            if ('http://' in url or 'https://' in url) and url not in unique_urls:
                unique_urls.append(url)
        if len(unique_urls) < len(processed_lines):
            self.add_log(f'已过滤 {len(processed_lines) - len(unique_urls)} 个无效或重复URL，保留 {len(unique_urls)} 个有效URL')
        return unique_urls

    def _start_parsing(self):
        """开始解析链接"""
        urls = self._get_parser_url_list()
        if not urls:
            messagebox.showinfo('提示', '请输入要解析的视频链接')
            return
        concurrent = self.parser_concurrent.get()
        msg = f'将解析 {len(urls)} 个视频链接，并发数: {concurrent}，是否继续？'
        if not messagebox.askyesno('确认', msg):
            return
        self.parse_button.config(state=tk.DISABLED)
        self.stop_parse_button.config(state=tk.NORMAL)
        self.parser_progress_var.set(0)
        self.parser_progress_label.config(text=f'0/{len(urls)}')
        self.parser_result_text.delete(1.0, tk.END)
        
        # Set the global RUNNING flag via settings module
        settings.RUNNING = True
        
        # Start the parsing thread
        self.parser_thread = threading.Thread(target=self._run_parsing, args=(urls,))
        self.parser_thread.daemon = True
        self.parser_thread.start()

    def _run_parsing(self, urls):
        """运行链接解析线程"""
        total = len(urls)
        completed = 0
        results = []
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            concurrent = self.parser_concurrent.get()
            concurrent = max(1, concurrent)
            self.add_log(f'开始解析 {len(urls)} 个链接，并发数: {concurrent}')
            semaphore = asyncio.Semaphore(concurrent)

            async def process_url(url):
                async with semaphore:
                    # Check RUNNING flag via settings module
                    if not settings.RUNNING:
                        return None
                    
                    self.add_log(f"正在解析: {url}")
                    try:
                        result = await extract_douyin_url(url)
                        if result['success']:
                            video_url = result['video_url']
                            title = result.get('title', '未知标题')
                            self.add_log(f'解析成功: {url} -> {title}')
                            result_line = f'原始链接: {url}\n标题: {title}\n视频链接: {video_url}\n'
                            if 'api_response' in result:
                                result_line += f"\nAPI原始响应:\n{result['api_response']}\n"
                            result_line += '\n'
                            self.root.after(0, lambda t=result_line: self.parser_result_text.insert(tk.END, t))
                            return {'original_url': url, 'title': title, 'video_url': video_url, 'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S'), 'api_response': result.get('api_response', '')}
                        else:
                            error_msg = result['message']
                            self.add_log(f'解析失败: {url} - {error_msg}')
                            error_line = f'原始链接: {url}\n解析失败: {error_msg}\n\n'
                            self.root.after(0, lambda t=error_line: self.parser_result_text.insert(tk.END, t))
                            return {'original_url': url, 'error': error_msg, 'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
                    except Exception as e:
                        error_detail = traceback.format_exc()
                        self.add_log(f'解析异常: {url} - {str(e)}')
                        error_line = f'原始链接: {url}\n解析异常: {str(e)}\n\n'
                        self.root.after(0, lambda t=error_line: self.parser_result_text.insert(tk.END, t))
                        return {'original_url': url, 'error': str(e), 'error_detail': error_detail, 'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
                    finally:
                        nonlocal completed
                        completed += 1
                        progress = completed / total * 100
                        self.root.after(0, lambda p=progress: self.parser_progress_var.set(p))
                        self.root.after(0, lambda c=completed, t=total: self.parser_progress_label.config(text=f'{c}/{t}'))
            tasks = [process_url(url) for url in urls]
            task_results = loop.run_until_complete(asyncio.gather(*tasks))
            results = [r for r in task_results if r]
            if results and self.parser_auto_save.get(): # <--- 添加条件判断
                try:
                    save_dir = self.parser_save_path.get()
                    if not save_dir:
                        save_dir = 'C:\\Users\\53246\\Desktop\\解析结果'
                    os.makedirs(save_dir, exist_ok=True)
                    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
                    json_path = os.path.join(save_dir, f'url_parser_results_{timestamp}.json')
                    with open(json_path, 'w', encoding='utf-8') as f:
                        json.dump(results, f, ensure_ascii=False, indent=2)
                    self.add_log(f'已自动保存JSON结果到: {json_path}')
                except Exception as e:
                    self.add_log(f'保存JSON结果失败: {str(e)}')
        except Exception as e:
            self.add_log(f'链接解析过程中出错: {str(e)}')
        finally:
            if 'loop' in locals() and loop.is_running():
                loop.stop()
            if 'loop' in locals() and (not loop.is_closed()):
                loop.close()
            self.root.after(0, self._parsing_complete)

    def _parsing_complete(self):
        """链接解析完成后的操作"""
        self.parse_button.config(state=tk.NORMAL)
        self.stop_parse_button.config(state=tk.DISABLED)
        self.add_log('链接解析任务完成')
        messagebox.showinfo('完成', '所有链接解析任务已完成')

    def _stop_parsing(self):
        """停止链接解析"""
        # Set the global RUNNING flag via settings module
        settings.RUNNING = False
        
        self.add_log("正在停止链接解析...")
        self.stop_parse_button.config(state=tk.DISABLED)

    def _clear_url_input(self):
        """清空URL列表输入框和文件路径"""
        self.url_text.delete(1.0, tk.END)
        self.file_path.set("") # Also clear the file path entry
        self.add_log("URL输入区域已清空") # Optional log message

    def _browse_image_url_file(self):
        """浏览并选择画面提取URL文件"""
        file_path = filedialog.askopenfilename(
            title='选择URL文件', 
            filetypes=[('文本文件', '*.txt'), ('JSON文件', '*.json'), ('所有文件', '*.*')]
        )
        if file_path:
            self.image_file_path.set(file_path)
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                    self.image_url_text.delete(1.0, tk.END)
                    self.image_url_text.insert(tk.END, content)
                self.add_log(f'已选择文件并加载内容: {file_path}')
            except Exception as e:
                error_msg = str(e)
                self.add_log(f'读取文件失败: {error_msg}')
                messagebox.showerror('读取错误', f'无法读取文件内容: {error_msg}')

    def _browse_image_save_path(self):
        """浏览并选择画面提取结果保存目录"""
        save_dir = filedialog.askdirectory(
            title='选择结果保存目录', 
            initialdir=self.image_save_path.get()
        )
        if save_dir:
            self.image_save_path.set(save_dir)
            self.add_log(f'已设置保存目录: {save_dir}')

    def _start_frame_extraction(self):
        """开始提取画面"""
        if self.image_running:
            self.add_log("提取画面任务已在运行中，请勿重复启动。")
            return
        
        # 读取选中的提示词文件内容
        selected_prompt_file = self.selected_prompt_file.get()
        if not selected_prompt_file:
            messagebox.showinfo("提示", "请选择一个提示词文件")
            return
            
        prompt_file_path = os.path.join(self.PROMPT_DIR, selected_prompt_file)
        try:
            with open(prompt_file_path, 'r', encoding='utf-8') as f:
                self.prompt_template = f.read()
                self.add_log(f"已读取提示词文件: {selected_prompt_file}")
        except Exception as e:
            error_msg = f"读取提示词文件失败: {str(e)}"
            self.add_log(error_msg)
            messagebox.showerror("错误", error_msg)
            return
            
        # 获取URL列表
        urls = self._get_image_url_list()
        if not urls:
            messagebox.showinfo("提示", "请输入要提取画面的URL")
            return
            
        # 用户确认
        msg = f"将提取 {len(urls)} 个URL的画面内容，是否继续？"
        if not messagebox.askyesno("确认", msg):
            return
            
        # 重置状态
        self.add_log("重置提取画面状态...")
        self.image_all_cf_tasks_processed.clear() # <--- 重置Event (红灯)
        with self.image_lock:
            self.image_pending_cf_tasks.clear()
            self.image_results.clear() # <--- 恢复这行
            self.image_tasks_completed = 0
            self.image_total_tasks = len(urls)
        
        # 加入队列
        for url in urls:
            self.image_task_queue.put(url)
            
        # 更新状态
        self.image_running = True
        self.start_image_button.config(state=tk.DISABLED)
        self.stop_image_button.config(state=tk.NORMAL)
        
        # 清空结果区
        self.image_result_text.delete(1.0, tk.END)
        
        # 获取并发数
        concurrent = self.image_concurrent.get()
        
        # 启动线程
        self.image_manager_thread = threading.Thread(
            target=self._image_manager_thread, 
            args=(concurrent,), 
            daemon=True
        )
        self.image_manager_thread.start()
        
        self.image_poller_thread = threading.Thread(
            target=self._image_poller_thread,
            daemon=True
        )
        self.image_poller_thread.start()
        
        self.add_log(f"开始提取画面任务，共 {self.image_total_tasks} 个URL，并发数: {concurrent}，使用提示词: {selected_prompt_file}")
        
    def _image_manager_thread(self, concurrent):
        """画面提取管理线程函数"""
        self.add_log(f"画面提取管理线程启动，并发数: {concurrent}")
        try:
            # 初始化或获取asyncio事件循环
            if not hasattr(self, 'loop') or self.loop.is_closed():
                self.loop = asyncio.new_event_loop()
                asyncio.set_event_loop(self.loop)
                self.add_log("已创建新的asyncio事件循环")
            
            # 创建信号量控制并发
            semaphore = asyncio.Semaphore(concurrent)
            
            # 创建任务列表
            tasks = []
            
            # 从队列取任务并创建asyncio任务
            self.add_log("开始从队列获取任务并创建asyncio workers...")
            while not self.image_task_queue.empty() and self.image_running:
                try:
                    original_url = self.image_task_queue.get_nowait()
                    task = asyncio.ensure_future(
                        self._image_worker(original_url, semaphore), 
                        loop=self.loop
                    )
                    tasks.append(task)
                except queue.Empty:
                    break
            self.add_log(f"已创建 {len(tasks)} 个worker任务")
                    
            # 运行所有worker任务
            if tasks:
                self.add_log("开始运行asyncio.gather等待worker完成...")
                self.loop.run_until_complete(asyncio.gather(*tasks))
                self.add_log("asyncio.gather已完成")
                
        except Exception as e:
            error_msg = f"画面提取管理线程异常: {str(e)}"
            self.root.after(0, lambda: self.add_log(error_msg))
            traceback_info = traceback.format_exc()
            self.root.after(0, lambda: self.add_log(f"详细错误信息: {traceback_info}"))
            
        finally:
            self.add_log("画面提取管理线程进入finally块...")
            # 清理事件循环资源
            try:
                self.add_log("开始清理asyncio任务...")
                pending = asyncio.all_tasks(self.loop) if hasattr(asyncio, 'all_tasks') else asyncio.Task.all_tasks(self.loop)
                if pending:
                    self.add_log(f"发现 {len(pending)} 个待处理/已完成的asyncio任务，尝试取消未完成的...")
                    for task in pending:
                        if not task.done():
                            task.cancel()
                    self.loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
                    self.add_log("已完成待处理asyncio任务的清理")
                else:
                    self.add_log("没有待处理的asyncio任务需要清理")
            except Exception as e:
                self.add_log(f"清理事件循环时出错: {str(e)}")

            # >>> 添加等待逻辑 <<< 
            #self.add_log("画面提取管理线程 - 等待所有CF任务处理完成信号 (Event.wait())...")
            self.image_all_cf_tasks_processed.wait() # 等待绿灯
            # 重置Event以便下次使用
            self.image_all_cf_tasks_processed.clear()
            #self.add_log("画面提取管理线程 - 收到所有CF任务处理完成信号 (Event is set)")
            
            # 任务完成后通知UI线程
            #self.add_log("准备调用_image_processing_complete...")
            self.root.after(0, self._image_processing_complete)
            
            # 确保按钮状态更新，即使_image_processing_complete函数没有执行或失败
            self.root.after(0, lambda: self.start_image_button.config(state=tk.NORMAL))
            self.root.after(0, lambda: self.stop_image_button.config(state=tk.DISABLED))
            
            self.add_log("画面提取管理线程结束")
        
    async def _image_worker(self, original_url, semaphore):
        """处理单个URL的画面提取Worker"""
        async with semaphore:
            # 检查是否已被停止
            if not self.image_running:
                return
                
            # 步骤1: 调用Go服务解析
            self.root.after(0, self.add_log, f"开始解析: {original_url}")
            try:
                loop = asyncio.get_running_loop()
                parse_result = await loop.run_in_executor(None, extract_douyin_url_sync, original_url)
                
                # 处理解析结果
                if parse_result.get('success') and parse_result.get('video_url'):
                    video_url = parse_result.get('video_url')
                    self.root.after(0, self.add_log, f"解析成功: {original_url}")
                else:
                    # 解析失败
                    error_msg = parse_result.get('message', '解析成功但未找到视频链接')
                    self.root.after(0, self.add_log, f"解析失败: {original_url} - {error_msg}")
                    with self.image_lock:
                        self.image_results[original_url] = f"Go服务解析失败: {error_msg}"
                        self.image_tasks_completed += 1
                    self.root.after(0, self._update_image_results_ui)
                    return
            except Exception as e:
                # 处理异常
                error_msg = str(e)
                self.root.after(0, self.add_log, f"解析异常: {original_url} - {error_msg}")
                with self.image_lock:
                    self.image_results[original_url] = f"解析过程出现异常: {error_msg}"
                    self.image_tasks_completed += 1
                self.root.after(0, self._update_image_results_ui)
                return
                
            # 检查是否已被停止
            if not self.image_running:
                return
                
            # 步骤2: 调用CF API提交
            self.root.after(0, self.add_log, f"开始提交CF: {original_url}")
            try:
                # 传递提示词模板到process_video方法
                response = self.cf_client.process_video(video_url, prompt_template=self.prompt_template)
                
                # 处理提交结果
                if response.get('success'):
                    cf_task_id = response.get('id')
                    with self.image_lock:
                        self.image_pending_cf_tasks[cf_task_id] = original_url
                    self.root.after(0, self.add_log, f"提交CF成功: {original_url}, TaskID: {cf_task_id}")
                else:
                    # 提交失败
                    error_msg = response.get('error', '提交CF任务未知错误')
                    self.root.after(0, self.add_log, f"提交CF失败: {original_url} - {error_msg}")
                    with self.image_lock:
                        self.image_results[original_url] = f"提交CF失败: {error_msg}"
                        self.image_tasks_completed += 1
                    self.root.after(0, self._update_image_results_ui)
                    return
            except Exception as e:
                # 处理异常
                error_msg = str(e)
                self.root.after(0, self.add_log, f"提交CF异常: {original_url} - {error_msg}")
                with self.image_lock:
                    self.image_results[original_url] = f"提交CF过程出现异常: {error_msg}"
                    self.image_tasks_completed += 1
                self.root.after(0, self._update_image_results_ui)
                return

    def _image_poller_thread(self):
        """用于轮询图片任务状态的线程"""
        try:
            self.add_log("CF任务状态轮询线程已启动。")
            
            complete_status_count = {}  # 用于记录任务连续在完成状态的次数
            
            while self.image_running:
                # 获取待处理任务列表的副本
                with self.image_lock:
                    # 如果没有待处理的任务了，检查是否应该结束
                    if not self.image_pending_cf_tasks:
                        # self.add_log("轮询线程 - 检测到无待处理任务") # <<< 用户要求注释掉
                        # 如果已经都处理完了，设置事件并退出
                        if self.image_tasks_completed == self.image_total_tasks and self.image_total_tasks > 0:
                            #self.add_log("轮询线程 - 所有任务已处理完成，设置所有CF任务处理完成信号")
                            self.image_all_cf_tasks_processed.set()
                            break
                        # 防止可能的不同步情况，继续循环等待
                        continue
                    
                    # 复制当前的任务ID列表（不获取锁）
                    pending_task_ids = list(self.image_pending_cf_tasks.keys())
                
                # 逐个查询任务状态
                for cf_task_id in pending_task_ids:
                    try:
                        # 检查状态
                        # self.add_log(f"轮询线程 - 查询任务: {cf_task_id}") # 注释掉过于频繁的日志
                        status_response = self.cf_client.get_status(cf_task_id)
                        
                        # 如果响应体为空，跳过处理
                        if not status_response:
                            # self.add_log(f"轮询线程 - 任务状态响应为空: {cf_task_id}") # 减少冗余日志
                            continue
                            
                        task_status = status_response.get('status', '').strip().lower() if isinstance(status_response.get('status'), str) else ''
                        # self.add_log(f"轮询线程 - 任务状态: {cf_task_id} = {task_status}") # 注释掉过于频繁的日志
                        
                        # 根据任务状态进行处理
                        if task_status in ['complete', 'completed', 'error', 'errored', 'failed']:
                            # 如果状态为完成或失败，记录状态次数
                            complete_status_count[cf_task_id] = complete_status_count.get(cf_task_id, 0) + 1
                            
                            # 确保有足够的状态证据
                            # 注意：API有时会反复返回"completed"然后又返回"in progress"，所以等待多次确认
                            if complete_status_count.get(cf_task_id, 0) >= 2:
                                # 处理最终任务状态
                                final_status_to_format = status_response
                                original_url = "未知原始URL"
                                formatted_result = f"任务 {cf_task_id} 处理完成/失败，但无法关联原始URL"
                                
                                # 查找对应的原始URL，并格式化结果
                                with self.image_lock:
                                    #self.add_log(f"轮询线程 - 加锁处理完成/失败任务: {cf_task_id}")
                                    if cf_task_id in self.image_pending_cf_tasks:
                                        original_url = self.image_pending_cf_tasks.pop(cf_task_id)
                                        self.add_log(f"轮询线程 - 找到并移除任务: {cf_task_id}, 原始URL: {original_url}")
                                        
                                        # 使用带原始数据的格式化方法
                                        format_result_with_raw = self.cf_client.format_result(final_status_to_format, include_raw=True)
                                        if isinstance(format_result_with_raw, dict) and 'formatted' in format_result_with_raw and 'raw' in format_result_with_raw:
                                            formatted_result = format_result_with_raw['formatted']
                                            # 保存原始响应数据
                                            self.image_raw_results[original_url] = format_result_with_raw['raw']
                                            self.add_log(f"轮询线程 - 已保存原始响应数据 (URL: {original_url})")
                                        else:
                                            # 如果没有返回预期的结构，使用旧方法
                                            formatted_result = format_result_with_raw
                                            self.add_log(f"轮询线程 - 未收到预期的原始响应数据格式，使用旧方法 (URL: {original_url})")
                                        
                                        self.image_results[original_url] = formatted_result
                                        self.image_tasks_completed += 1
                                        self.add_log(f"轮询线程 - 更新结果和计数器: completed={self.image_tasks_completed}/{self.image_total_tasks}")
                                    else:
                                        # 可能已被其他线程处理，或状态更新存在延迟
                                        self.root.after(0, self.add_log, 
                                                       f"警告：轮询线程发现任务 {cf_task_id} 已完成/失败，但无法在待处理列表中找到它。")
                                        self.add_log(f"轮询线程 - 解锁 (未找到任务 {cf_task_id})")
                                        continue
                                #self.add_log(f"轮询线程 - 解锁 (已处理任务 {cf_task_id})")
                                
                                # 记录日志并更新UI
                                task_result = "完成" if task_status == 'complete' else "失败"
                                self.root.after(0, self.add_log, f"任务{task_result}: {original_url} (ID: {cf_task_id})")
                                #self.add_log(f"轮询线程 - 准备调用 UI 更新 ({cf_task_id})")
                                self.root.after(0, self._update_image_results_ui)
                                
                                # 从计数器中移除已处理的任务
                                if cf_task_id in complete_status_count:
                                    del complete_status_count[cf_task_id]
                        
                    except Exception as e:
                        # 处理轮询过程中的异常
                        error_msg = str(e)
                        self.root.after(0, self.add_log, f"轮询线程 - 轮询异常 (TaskID: {cf_task_id}): {error_msg}")
                        traceback_info = traceback.format_exc()
                        self.root.after(0, self.add_log, f"详细错误信息: {traceback_info}")
                        # 如果连续多次查询失败，可以考虑将任务标记为失败
                
                # 按配置的轮询间隔等待
                polling_interval = getattr(CF_CONFIG, 'polling_interval', 20)  # 默认20秒
                time.sleep(polling_interval)
                
            self.add_log("轮询线程 - 退出主循环") # 确认线程退出
                
        except Exception as e:
            # 处理轮询线程整体异常
            error_msg = str(e)
            self.root.after(0, self.add_log, f"轮询线程 - 线程异常: {error_msg}")
            traceback_info = traceback.format_exc()
            self.root.after(0, self.add_log, f"详细错误信息: {traceback_info}")
            
        finally:
            # 无论如何都会执行的清理代码
            self.root.after(0, self.add_log, "CF任务状态轮询线程已停止。") # 修改停止日志
            
            # 如果线程是正常结束而不是被停止，确保设置完成信号
            if self.image_running and not self.image_all_cf_tasks_processed.is_set():
                # self.add_log("轮询线程 - 结束时设置所有CF任务处理完成信号 (Event.set())") # 内部逻辑日志
                self.image_all_cf_tasks_processed.set()
                
            # 确保按钮状态更新
            self.root.after(0, lambda: self.start_image_button.config(state=tk.NORMAL))
            self.root.after(0, lambda: self.stop_image_button.config(state=tk.DISABLED))

    def _stop_frame_extraction(self):
        """停止画面提取过程"""
        self.add_log("收到停止提取画面任务请求...")
        
        # 设置停止标志
        self.image_running = False
        
        # 更新按钮状态
        self.start_image_button.config(state=tk.NORMAL)
        self.stop_image_button.config(state=tk.DISABLED)
        
        # 启动一个守护线程来等待后台线程结束，避免阻塞UI
        def wait_for_threads():
            if self.image_manager_thread and self.image_manager_thread.is_alive():
                self.image_manager_thread.join()
            if self.image_poller_thread and self.image_poller_thread.is_alive():
                self.image_poller_thread.join()
            self.root.after(0, self.add_log, "提取画面的后台线程已完全停止。")
            
        threading.Thread(target=wait_for_threads, daemon=True).start()
        
    def _image_processing_complete(self):
        """画面提取完成后的操作"""
        # self.add_log("函数 _image_processing_complete 被调用") # 注释掉函数进入日志
        # 如果是手动停止触发的，则停止函数已处理
        if not self.image_running:
            self.add_log("_image_processing_complete: 检测到 image_running 为 False，提前返回")
            return
            
        # 设置停止标志
        # self.add_log("_image_processing_complete: 设置 image_running = False") # 内部逻辑日志
        self.image_running = False
        
        # 更新按钮状态
        # self.add_log("_image_processing_complete: 更新按钮状态") # 内部逻辑日志
        self.start_image_button.config(state=tk.NORMAL)
        self.stop_image_button.config(state=tk.DISABLED)
        
        # 调用任务总结函数
        # self.add_log("_image_processing_complete: 调用 _add_image_task_summary") # 内部逻辑日志
        self._add_image_task_summary()
        
        # 检查是否自动保存结果
        if self.image_auto_save.get():
            # self.add_log("_image_processing_complete: 检测到自动保存已开启，准备保存JSON结果") # 内部逻辑日志
            self._save_image_results_as_json()
        else:
            # self.add_log("_image_processing_complete: 自动保存已关闭，跳过保存JSON结果") # 内部逻辑日志
            pass
        
        # 记录日志
        self.add_log("提取画面任务已全部处理完成。")
        # self.add_log("函数 _image_processing_complete 结束") # 注释掉函数结束日志
        
    def _update_image_results_ui(self):
        """更新画面提取结果到UI"""
        # self.add_log("函数 _update_image_results_ui 被调用") # 注释掉函数进入日志
        # 清空结果区域
        # self.add_log("_update_image_results_ui: 清空结果区域") # 内部逻辑日志
        self.image_result_text.delete(1.0, tk.END)
        
        # 安全地获取结果副本
        results_copy = {}
        # self.add_log("_update_image_results_ui: 加锁获取结果副本") # 内部逻辑日志
        with self.image_lock:
            results_copy = self.image_results.copy()
            # self.add_log(f"_update_image_results_ui: 结果副本包含 {len(results_copy)} 项") # 内部逻辑日志
        # self.add_log("_update_image_results_ui: 解锁") # 内部逻辑日志
            
        # 更新UI显示
        # self.add_log("_update_image_results_ui: 开始更新UI") # 内部逻辑日志
        for original_url, result_text in results_copy.items():
            # result_text包含由format_result生成的完整文本或错误信息
            display_text = f"原始URL: {original_url}\n结果:\n{result_text}\n{'-'*50}\n"
            self.image_result_text.insert(tk.END, display_text)
        # self.add_log("_update_image_results_ui: UI更新完成") # 内部逻辑日志
            
        # 滚动到最新内容
        self.image_result_text.see(tk.END)
        
        # 更新进度显示
        # self.add_log("_update_image_results_ui: 加锁更新进度日志") # 内部逻辑日志
        with self.image_lock:
            progress_text = f"进度: {self.image_tasks_completed}/{self.image_total_tasks}"
            # self.add_log(progress_text) # 进度日志
        # self.add_log("_update_image_results_ui: 解锁") # 内部逻辑日志
        # self.add_log("函数 _update_image_results_ui 结束") # 注释掉函数结束日志
            
    def _add_image_task_summary(self):
        """生成并记录画面提取任务统计信息"""
        # self.add_log("函数 _add_image_task_summary 被调用") # 注释掉函数进入日志
        successful_count = 0
        failed_count = 0
        
        # 安全地获取结果副本
        results_copy = {}
        # self.add_log("_add_image_task_summary: 加锁获取结果副本") # 内部逻辑日志
        with self.image_lock:
            results_copy = self.image_results.copy()
            # self.add_log(f"_add_image_task_summary: 结果副本包含 {len(results_copy)} 项") # 内部逻辑日志
        # self.add_log("_add_image_task_summary: 解锁") # 内部逻辑日志
            
        # 统计成功和失败数量
        # self.add_log("_add_image_task_summary: 开始统计成功/失败数量") # 内部逻辑日志
        for result_text in results_copy.values():
            # 根据结果文本判断是成功还是失败
            if "失败" in result_text or "异常" in result_text or "错误" in result_text:
                failed_count += 1
            else:
                successful_count += 1
        self.add_log(f"_add_image_task_summary: 统计完成 - 成功: {successful_count}, 失败: {failed_count}")
                
        # 计算总数并生成总结
        total_processed = successful_count + failed_count
        summary = f"\n【提取画面任务总结】\n总提交URL数: {self.image_total_tasks}\n处理完成数: {total_processed}\n成功数量: {successful_count}\n失败数量: {failed_count}\n"
        
        # 记录总结信息
        # self.add_log("_add_image_task_summary: 添加总结日志") # 内部逻辑日志
        self.add_log(summary) # 保留总结信息
        
        # 同时显示在结果区域
        # self.add_log("_add_image_task_summary: 将总结添加到结果区域") # 内部逻辑日志
        self.image_result_text.insert(tk.END, f"\n{summary}")
        self.image_result_text.see(tk.END)
        self.add_log("函数 _add_image_task_summary 结束")

    def _clear_image_input(self):
        """清空画面提取的输入内容"""
        self.image_url_text.delete(1.0, tk.END)
        self.image_file_path.set("")
        self.add_log("已清空提取画面输入区域。")
        
    def _get_image_url_list(self):
        """获取要提取画面的URL列表"""
        content = self.image_url_text.get(1.0, tk.END).strip()
        if not content:
            file_path = self.image_file_path.get()
            if file_path and os.path.exists(file_path):
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        content = f.read().strip()
                except Exception as e:
                    self.add_log(f'读取文件失败: {str(e)}')
                    return []
        lines = content.splitlines()
        processed_lines = []
        for line in lines:
            line = line.strip()
            if not line:
                continue
            if '抖音' in line or 'douyin' in line.lower() or 'ixigua' in line.lower() or ('tiktok' in line.lower()):
                clean_url = extract_douyin_link_from_text(line)
                if clean_url != line:
                    self.add_log(f'已清理抖音分享文本: {line} -> {clean_url}')
                processed_lines.append(clean_url)
            else:
                processed_lines.append(line)
        unique_urls = []
        for url in processed_lines:
            if ('http://' in url or 'https://' in url) and url not in unique_urls:
                unique_urls.append(url)
        if len(unique_urls) < len(processed_lines):
            self.add_log(f'已过滤 {len(processed_lines) - len(unique_urls)} 个无效或重复URL，保留 {len(unique_urls)} 个有效URL')
        return unique_urls
        
    def _copy_text(self, text_widget):
        """复制文本组件中的内容到剪贴板"""
        try:
            content = text_widget.get(1.0, tk.END).strip()
            if not content:
                self.add_log("没有内容可复制")
                messagebox.showinfo('提示', '没有内容可复制')
                return
                
            self.root.clipboard_clear()
            self.root.clipboard_append(content)
            self.add_log("已复制内容到剪贴板")
            messagebox.showinfo('成功', '内容已复制到剪贴板')
        except Exception as e:
            error_msg = f"复制内容失败: {str(e)}"
            self.add_log(error_msg)
            messagebox.showerror('错误', error_msg)
            
    def _save_image_results_as_json(self):
        """将Gemini API的原始响应中提取text字段并保存为JSON"""
        # self.add_log("函数 _save_image_results_as_json 被调用") # 注释掉函数进入日志
        
        # 安全地获取结果副本
        results_copy = {}
        raw_results_copy = {}
        # self.add_log("_save_image_results_as_json: 加锁获取结果副本") # 内部逻辑日志
        with self.image_lock:
            results_copy = self.image_results.copy()
            raw_results_copy = self.image_raw_results.copy()
            # self.add_log(f"_save_image_results_as_json: 结果副本包含 {len(results_copy)} 项，原始结果包含 {len(raw_results_copy)} 项") # 内部逻辑日志
        # self.add_log("_save_image_results_as_json: 解锁") # 内部逻辑日志
        
        if not results_copy:
            messagebox.showinfo("提示", "没有可保存的结果")
            self.add_log("_save_image_results_as_json: 没有结果可保存")
            return
            
        # 确定保存位置
        save_dir = self.image_save_path.get().strip()  # 修改：添加 .strip() 处理
        if not save_dir:
            save_dir = os.path.join(os.path.expanduser('~'), 'Desktop', '画面提取结果')  # 修改：添加 '画面提取结果' 子文件夹
        
        try:
            os.makedirs(save_dir, exist_ok=True)
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            save_file = os.path.join(save_dir, f'image_analysis_{timestamp}.json')
            
            # 获取原始URL列表顺序
            ordered_urls = self._get_image_url_list()  # 获取原始URL顺序
            
            # 如果没有原始URL列表，则使用结果中的URL顺序
            if not ordered_urls:
                ordered_urls = list(results_copy.keys())
                
            self.add_log(f"_save_image_results_as_json: 处理 {len(ordered_urls)} 个URL的结果")
            
            # 创建新的JSON数组格式
            json_array = []
            
            # 按原始URL顺序提取text字段并构建新格式
            for url in ordered_urls:
                text_content = None
                
                # 方法1: 优先从原始响应数据中提取
                if url in raw_results_copy:
                    # self.add_log(f"_save_image_results_as_json: 使用原始响应数据提取text字段 (URL: {url})") # 内部逻辑日志
                    raw_response = raw_results_copy[url]
                    
                    try:
                        # 从原始响应中提取text值
                        if 'result' in raw_response and isinstance(raw_response['result'], dict):
                            result_data = raw_response['result']
                            if (result_data and 'candidates' in result_data and 
                                len(result_data['candidates']) > 0 and
                                'content' in result_data['candidates'][0] and
                                'parts' in result_data['candidates'][0]['content'] and
                                len(result_data['candidates'][0]['content']['parts']) > 0 and
                                'text' in result_data['candidates'][0]['content']['parts'][0]):
                                
                                text_content = result_data['candidates'][0]['content']['parts'][0]['text']
                                text_preview = text_content[:20] + "..." if text_content and len(text_content) > 20 else text_content
                                # self.add_log(f"_save_image_results_as_json: 成功从原始响应提取text字段，内容: {text_preview} (URL: {url})") # 内部逻辑日志
                        else:
                            # self.add_log(f"_save_image_results_as_json: 原始响应中没有result字段或格式不匹配 (URL: {url})") # 内部逻辑日志
                            pass # 添加 pass 语句以修复缩进块错误
                    except Exception as e:
                        self.add_log(f"_save_image_results_as_json: 从原始响应提取失败: {str(e)}") # 保留错误日志
                        
                # 方法2: 如果原始数据提取失败，尝试从格式化文本中提取
                if not text_content and url in results_copy:
                    self.add_log(f"_save_image_results_as_json: 尝试从格式化文本中提取 (URL: {url})")
                    result_text = results_copy[url]
                    
                    try:
                        # 查找原始API响应部分
                        api_response_match = re.search(r'Gemini API 原始响应体: ({[\s\S]*?})\s*\n\s*\n', result_text)
                        if api_response_match:
                            api_json_str = api_response_match.group(1)
                            self.add_log(f"_save_image_results_as_json: 提取到API响应JSON字符串，长度: {len(api_json_str)}")
                            api_json = json.loads(api_json_str)
                            
                            # 从candidates[0].content.parts[0].text中提取text
                            if (api_json and 'candidates' in api_json and 
                                len(api_json['candidates']) > 0 and
                                'content' in api_json['candidates'][0] and
                                'parts' in api_json['candidates'][0]['content'] and
                                len(api_json['candidates'][0]['content']['parts']) > 0 and
                                'text' in api_json['candidates'][0]['content']['parts'][0]):
                                
                                text_content = api_json['candidates'][0]['content']['parts'][0]['text']
                                text_preview = text_content[:20] + "..." if text_content and len(text_content) > 20 else text_content
                                # self.add_log(f"_save_image_results_as_json: 成功从格式化文本API响应部分提取text字段，内容: {text_preview} (URL: {url})") # 内部逻辑日志
                    except Exception as e:
                        self.add_log(f"_save_image_results_as_json: 解析格式化文本中的API响应失败: {str(e)}") # 保留错误日志
                        # 尝试备用方法 - 使用更宽松的正则表达式
                        try:
                            # 尝试先分割字符串，再解析JSON
                            if "Gemini API 原始响应体:" in result_text:
                                parts = result_text.split("Gemini API 原始响应体:", 1)
                                if len(parts) > 1:
                                    # 尝试查找完整的JSON对象
                                    json_text = parts[1].strip()
                                    # 找到第一个左花括号和最后一个右花括号
                                    start_idx = json_text.find('{')
                                    if start_idx >= 0:
                                        # 找到最后一个花括号前的完整JSON
                                        brace_count = 0
                                        for i, char in enumerate(json_text[start_idx:]):
                                            if char == '{':
                                                brace_count += 1
                                            elif char == '}':
                                                brace_count -= 1
                                                if brace_count == 0:
                                                    end_idx = start_idx + i + 1
                                                    api_json_str = json_text[start_idx:end_idx]
                                                    api_json = json.loads(api_json_str)
                                                    
                                                    if (api_json and 'candidates' in api_json and 
                                                        len(api_json['candidates']) > 0 and
                                                        'content' in api_json['candidates'][0] and
                                                        'parts' in api_json['candidates'][0]['content'] and
                                                        len(api_json['candidates'][0]['content']['parts']) > 0 and
                                                        'text' in api_json['candidates'][0]['content']['parts'][0]):
                                                        
                                                        text_content = api_json['candidates'][0]['content']['parts'][0]['text']
                                                        self.add_log(f"_save_image_results_as_json: 使用备用方法成功提取text字段 (URL: {url})")
                                                    break
                        except Exception as e2:
                            self.add_log(f"_save_image_results_as_json: 备用解析方法也失败: {str(e2)}")
                
                # 方法3: 如果仍未能提取到text，尝试从格式化的结果中提取描述文本
                if not text_content and url in results_copy:
                    result_text = results_copy[url]
                    try:
                        # 从完整描述部分提取
                        full_text_match = re.search(r'完整描述:\n([\s\S]+?)(?:\n-{10,}|\n={10,}|\Z)', result_text)
                        if full_text_match:
                            text_content = full_text_match.group(1).strip()
                            # self.add_log(f"_save_image_results_as_json: 从完整描述提取文本 (URL: {url})") # 内部逻辑日志
                        else:
                            # 从分析结果预览提取
                            preview_match = re.search(r'分析结果预览: (.*?)(?:\n|$)', result_text)
                            if preview_match:
                                text_content = preview_match.group(1).strip()
                                # 移除可能的引号或特殊符号
                                text_content = re.sub(r'^[\s`\'"]|[\s`\'"]$', '', text_content)
                                # self.add_log(f"_save_image_results_as_json: 从预览提取文本 (URL: {url})") # 内部逻辑日志
                            else:
                                # 如果所有提取方法都失败，使用整个结果文本
                                text_content = result_text
                                self.add_log(f"_save_image_results_as_json: 使用整个结果文本 (URL: {url})")
                    except Exception as e:
                        self.add_log(f"_save_image_results_as_json: 从格式化结果提取描述失败: {str(e)}") # 保留错误日志
                        # text_content = result_text
                        # self.add_log(f"_save_image_results_as_json: 使用整个结果文本作为备选 (URL: {url})") # 内部逻辑日志
                
                # 如果URL既不在原始结果中也不在格式化结果中
                if not text_content:
                    # self.add_log(f"_save_image_results_as_json: URL不在任何结果中或无法提取有效内容: {url}") # 内部逻辑日志
                    text_content = "无法分析画面"  # 对于没有结果的URL，添加明确的错误信息
                
                # 添加结果对象到JSON数组
                json_array.append({
                    "url": url,
                    "image_content": text_content
                })
            
            # 保存到文件
            with open(save_file, 'w', encoding='utf-8') as f:
                json.dump(json_array, f, ensure_ascii=False, indent=2)
                
            self.add_log(f"成功保存 {len(json_array)} 个结果到 {save_file}") # 保留成功保存日志
            messagebox.showinfo("成功", f"已保存 {len(json_array)} 个结果到文件:\n{save_file}")
            
        except Exception as e:
            error_msg = f"保存结果失败: {str(e)}"
            self.add_log(f"_save_image_results_as_json: {error_msg}") # 保留错误日志
            messagebox.showerror("错误", error_msg)
            
        self.add_log("函数 _save_image_results_as_json 结束")
        
    # --- 新增方法：启动后台解析服务 ---
    def _start_analysis_service(self):
        """启动后台的 analysis.exe 服务"""
        try:
            # 使用辅助函数获取 analysis.exe 的路径
            analysis_exe_path = resource_path('analysis.exe')

            if not os.path.exists(analysis_exe_path):
                self.add_log(f"错误: 未找到解析服务程序: {analysis_exe_path}")
                messagebox.showerror("启动错误", f"未找到后台服务程序:\n{analysis_exe_path}\n\n链接解析功能将不可用。")
                self.analysis_process = None
                return

            # 使用 Popen 在后台启动，不显示窗口 (Windows)
            # 注意：如果 analysis.exe 需要特定的工作目录，请设置 cwd 参数
            creationflags = 0
            if sys.platform == "win32":
                creationflags = subprocess.CREATE_NO_WINDOW
            
            self.analysis_process = subprocess.Popen([analysis_exe_path], creationflags=creationflags)
            self.add_log(f"后台解析服务已启动: {analysis_exe_path} (PID: {self.analysis_process.pid})")

        except Exception as e:
            self.add_log(f"启动后台解析服务时出错: {str(e)}")
            messagebox.showerror("启动错误", f"启动后台服务时出错:\n{str(e)}")
            self.analysis_process = None
        