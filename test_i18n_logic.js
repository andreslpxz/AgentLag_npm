import { t, setLanguage, getAvailableLanguages } from './i18n.js';
import { SLASH_COMMANDS } from './commands.js';
import { THINKING_WORDS } from './agent_runner.js';

function testTranslations() {
    console.log('Testing translations...');

    const langs = getAvailableLanguages();
    console.log('Available languages:', langs);

    langs.forEach(lang => {
        setLanguage(lang);
        console.log(`\nChecking language: ${lang.toUpperCase()}`);

        const welcome = t('welcome');
        console.log(`  welcome: ${welcome}`);

        // Check a slash command description
        const mcpDesc = SLASH_COMMANDS.find(c => c.cmd === '/mcp').desc[0];
        console.log(`  /mcp desc: ${mcpDesc}`);

        // Check a thinking word
        const think1 = t(THINKING_WORDS[0]);
        console.log(`  think_1: ${think1}`);

        if (mcpDesc === 'cmd_mcp_desc' || welcome === 'welcome') {
            console.error(`  FAIL: Key not translated for ${lang}`);
            process.exit(1);
        }
    });

    console.log('\nAll basic translation checks passed!');
}

testTranslations();
