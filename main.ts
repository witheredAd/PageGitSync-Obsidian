import { Plugin, Notice, normalizePath, TFile } from 'obsidian';
import git from 'isomorphic-git';
// import http from 'isomorphic-git/http/web';
import { ObsidianHTTPClient as http } from 'http-client';
import FS from '@isomorphic-git/lightning-fs';

import matter from 'gray-matter';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { toString } from 'mdast-util-to-string';

import * as path from 'path-browserify';

import { MySettingTab } from './settings';

// FIXME: 图片存储路径我不希望是 /public/image
// TODO: 对于不再 Publish 的笔记的删除（=unlink in POSIX）

// 初始化 IndexedDB 文件系统
const IndexDB_NAME = 'obsidian-git-db'
const fs = new FS(IndexDB_NAME); 
const dir = '/repo'; // 虚拟路径

interface MyPluginSettings {
    gitUrl: string, // https://github.com/user/repo.git
    gitToken: string, // ghp_xxxxxxxxxxxx
    username: string
}

const DEFAULT_SETTINGS: Partial<MyPluginSettings> = {
   
};

export default class MyPlugin extends Plugin {
    settings: MyPluginSettings
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async fileExists(filepath: string): Promise<boolean> {
        try {
            await fs.promises.stat(filepath);
            return true;
        } catch (e) {
            return false;
        }
    }

    async createDirectoryRecursively(dirPath: string): Promise<void> {
        // 1. 获取标准化路径 (处理 /a//b/../c 等情况)
        const target = path.normalize(dirPath);

        // 2. 尝试检查目录是否存在
        try {
            await fs.promises.stat(target);
            // 如果 stat 成功，说明已存在，直接返回 (幂等性)
            return;
        } catch (err: any) {
            // 如果错误不是 "文件不存在" (ENOENT)，则真是个错误，抛出去
            if (err.code !== 'ENOENT') throw err;
        }

        // 3. 获取父级目录路径
        const parent = path.dirname(target);

        // 4. 递归终止条件：如果父级是根目录 '/' 或 '.' 且和当前相等，则无法再创建，跳过
        if (parent !== target && parent !== '/' && parent !== '.') {
            // 递归先创建父目录
            await this.createDirectoryRecursively(parent);
        }

        // 5. 父目录这就绪了，创建当前目录
        try {
            await fs.promises.mkdir(target);
        } catch (err: any) {
            // 并发容错：如果在递归回来的瞬间目录被创建了 (EEXIST)，则忽略
            if (err.code !== 'EEXIST') throw err;
        }
    }

    // 辅助：递归创建目录 (lightning-fs 不支持 recursive )
    async ensureDir(dirPath: string) {
        if (await this.fileExists(dirPath)) return;
        await this.createDirectoryRecursively(dirPath).catch((err: any) => {
            console.warn('mkdir failed, checking if it exists...', err);
        });
    }

    /**
     * 将 Vault 内容同步到 LightningFS (IndexedDB)
     * @param gitDir 虚拟文件系统中的仓库根目录 (例如 '/repo')
     */
    async copyVaultToVirtualFS(gitDir: string = dir) {
        new Notice('📦 正在准备虚拟文件系统...');
        
        const targetNotesDir = path.join(gitDir, 'src/notes');
        const targetImagesDir = path.join(gitDir, 'public/images');

        // 1. 确保目标目录结构存在
        // 注意：LightningFS 删除文件夹比较麻烦，为了性能，这里我们采取“覆盖策略”
        // 如果非要清空，需要递归删除，操作成本较高。
        await this.ensureDir(targetNotesDir);
        await this.ensureDir(targetImagesDir);

        // 2. 获取 Obsidian 所有 Markdown 文件
        const files = this.app.vault.getMarkdownFiles();
        let processedCount = 0;

        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            const frontmatter = cache?.frontmatter;

            // 过滤 Published: True
            if (frontmatter && (frontmatter.Published === true || frontmatter.Published === 'True')) {
                await this.processSingleFile(file, gitDir, targetNotesDir, targetImagesDir);
                processedCount++;
            }
        }
        
        console.log(`✅ 已处理 ${processedCount} 个文件到虚拟文件系统`);
    }

    async processSingleFile(
        file: TFile, 
        gitDir: string,
        targetNotesBase: string, 
        targetImagesBase: string
    ) {
        // A. 读取原始内容
        let content = await this.app.vault.read(file);
        const cache = this.app.metadataCache.getFileCache(file);
        
        // Step 1: 解析 Frontmatter 和 Body
        // matter() 自动处理 YAML 解析，并将正文分离到 content 属性
        const { data: frontmatter, content: bodyContent } = matter(content);

        // Step 2: 检查 Published (这里做个防御性检查，虽然外部可能已经过滤过)
        const isPublished = 
            frontmatter.Published === true || 
            frontmatter.Published === 'True';

        if (!isPublished) return;

        // ============================================================
        // 【逻辑还原】自动生成 desc
        // ============================================================
        if (!frontmatter.desc) {
            // 解析纯正文 (bodyContent) 为 AST
            // 注意：这里只 parse 不 stringify，性能开销很小
            const bodyTree = unified().use(remarkParse).parse(bodyContent);
            
            // toString 提取纯文本 (移除 markdown 符号)
            const plainText = toString(bodyTree).replace(/\s+/g, ' ').trim();
            
            // 截取前 100 个字符
            frontmatter.desc = plainText.slice(0, 100) + (plainText.length > 100 ? '...' : '');
        }
        // ============================================================

        // B. 准备目标路径 (SpecTag)
        const specTag = frontmatter?.SpecTag ? String(frontmatter.SpecTag).trim() : 'Uncategorized';
        const destDir = path.join(targetNotesBase, specTag);
        await this.ensureDir(destDir);

        // C. 处理图片引用 (Embeds)
        const embeds = cache?.embeds || [];
        if (embeds.length > 0) {
            for (const embed of embeds) {
                const imageFile = this.app.metadataCache.getFirstLinkpathDest(embed.link, file.path);
                
                // 确保是图片
                if (imageFile instanceof TFile && ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(imageFile.extension)) {
                    
                    // C1. 读取 Obsidian 图片数据 (ArrayBuffer)
                    const arrayBuffer = await this.app.vault.readBinary(imageFile);
                    // 转换为 Uint8Array (lightning-fs 需要)
                    const uint8Array = new Uint8Array(arrayBuffer);
                    
                    // C2. 写入虚拟文件系统
                    const imgFileName = imageFile.name;
                    const destImgPath = path.join(targetImagesBase, imgFileName);
                    
                    // 写入图片 (Binary)
                    await fs.promises.writeFile(destImgPath, uint8Array);
                }
            }
        }

        // Step 5: 重新组合并写入
        // matter.stringify 会自动把修改后的 frontmatter 对象转换回 YAML
        // 并与原始的 bodyContent 拼接。
        const newFileContent = matter.stringify(bodyContent, frontmatter);

        const destFilePath = path.join(destDir, file.name);
        await fs.promises.writeFile(destFilePath, newFileContent, 'utf8');
    }


    async sync() {
        // 1. 初始化或拉取
        if (!(await this.fileExists(dir))) {
            new Notice('Cloning repo (One time)...');
            await git.clone({
                fs, http, dir,
                url: this.settings.gitUrl,
                onAuth: () => ({ username: this.settings.gitToken, password: 'x-oauth-basic' }),
                singleBranch: true,
                depth: 1
            });
        } else {
            new Notice('Pulling repo...');
            await git.pull({
                fs, http, dir,
                url: this.settings.gitUrl,
                onAuth: () => ({ username: this.settings.gitToken, password: 'x-oauth-basic'  }),
                author: { name: this.settings.username, email: 'mobile@obsidian.md' }
            });
        }

        // 2. 将 Obsidian 文件写入虚拟文件系统
        // 这里需要遍历 Vault，把文件用 fs.promises.writeFile 写入 /repo/src/notes
        await this.copyVaultToVirtualFS();

        // 3. Git 操作
        new Notice('Gitting...');
        await git.add({ fs, dir, filepath: '.' });
        await git.commit({
            fs, dir,
            message: `Mobile Sync ${new Date().toISOString()}`,
            author: { name: this.settings.username, email: 'mobile@obsidian.md' }
        });
        
        await git.push({
            fs, http, dir,
            url: this.settings.gitUrl,
            onAuth: () => ({ username: this.settings.gitToken, password: 'x-oauth-basic' })
        });

        new Notice('✅ Pushed to GitHub. Deployment triggered via Actions.');
    }

    async clearRepo() {
        new Notice("Now removing fs cache...")
        fs.init(IndexDB_NAME, { wipe: true })
        new Notice("Successfully removed.")
    }
    
    async onload() {
        await this.loadSettings();

        this.addSettingTab(new MySettingTab(this.app, this));
        this.addRibbonIcon('cloud-upload', 'Publish with PageGitSync', () => {
            this.sync().catch((e) => {
                new Notice(`Error: ${e}`)
            })
        });

        this.addCommand({
            id: 'pagegit-clear-repo',
            name: 'Clear Repo FS Cache',
            callback: () => {
                this.clearRepo().catch((e) => {
                new Notice(`Error: ${e}`)
            })
            },
        })
    }
}