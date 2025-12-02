import ExamplePlugin from './main';
import { App, PluginSettingTab, Setting } from 'obsidian';

export class MySettingTab extends PluginSettingTab {
    plugin: ExamplePlugin;

    constructor(app: App, plugin: ExamplePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        let { containerEl } = this;

        containerEl.empty();

        
        new Setting(containerEl)
        .setName('git repo url (https)')
        .addText((text) => text
            .setPlaceholder('https://github.com/username/repo.git')
            .setValue(this.plugin.settings.gitUrl)
            .onChange(async (value) => {
                this.plugin.settings.gitUrl = value
                await this.plugin.saveSettings();
            })
        )

        new Setting(containerEl)
        .setName('git token')
        .addText((text) =>  text
            .setPlaceholder('Your PAT token here')
            .setValue(this.plugin.settings.gitToken)
            .onChange(async (value) => {
                this.plugin.settings.gitToken = value;
                await this.plugin.saveSettings();
            })
        )

        new Setting(containerEl)
        .setName('username')
        .addText((text) =>  text
            .setPlaceholder('Your username here')
            .setValue(this.plugin.settings.username)
            .onChange(async (value) => {
                this.plugin.settings.username = value;
                await this.plugin.saveSettings();
            })
        )
    }
}