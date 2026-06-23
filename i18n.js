import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_PATH = path.join(os.homedir(), '.agentlag', 'config.json');

const translations = {
    es: {
        welcome: "¡Bienvenido de nuevo!",
        select_provider: "Selecciona un proveedor de LLM:",
        enter_api_key: "Introduce tu API Key para",
        select_model: "Selecciona un modelo:",
        loading_models: "Cargando modelos de Ollama...",
        no_models_found: "No se encontraron modelos.",
        press_enter_to_continue: "Presiona Enter para continuar",
        thinking: "Pensando",
        searching: "Buscando",
        error: "Error",
        confirm_action: "¿Permitir que el agente ejecute esta herramienta?",
        yes: "Sí",
        no: "No",
        allow_all: "Sí, permitir todo en esta sesión",
        shortcuts_help: "? para atajos",
        effort: "esfuerzo",
        focus: "foco",
        react: "react",
        advisor: "asesor",
        language_selection: "Selecciona el idioma de la interfaz:",
        config_saved: "Configuración guardada correctamente.",
    },
    en: {
        welcome: "Welcome back!",
        select_provider: "Select an LLM provider:",
        enter_api_key: "Enter your API Key for",
        select_model: "Select a model:",
        loading_models: "Loading Ollama models...",
        no_models_found: "No models found.",
        press_enter_to_continue: "Press Enter to continue",
        thinking: "Thinking",
        searching: "Searching",
        error: "Error",
        confirm_action: "Allow the agent to run this tool?",
        yes: "Yes",
        no: "No",
        allow_all: "Yes, allow all for this session",
        shortcuts_help: "? for shortcuts",
        effort: "effort",
        focus: "focus",
        react: "react",
        advisor: "advisor",
        language_selection: "Select the interface language:",
        config_saved: "Configuration saved successfully.",
    },
    zh: {
        welcome: "欢迎回来！",
        select_provider: "选择 LLM 供应商：",
        enter_api_key: "输入 API 密钥：",
        select_model: "选择模型：",
        loading_models: "正在加载 Ollama 模型...",
        no_models_found: "未找到模型。",
        press_enter_to_continue: "按回车键继续",
        thinking: "思考中",
        searching: "搜索中",
        error: "错误",
        confirm_action: "允许代理运行此工具吗？",
        yes: "是",
        no: "否",
        allow_all: "是的，在此会话中允许所有操作",
        shortcuts_help: "? 查看快捷键",
        effort: "努力",
        focus: "专注",
        react: "推理",
        advisor: "顾问",
        language_selection: "选择界面语言：",
        config_saved: "配置已成功保存。",
    },
    pt: {
        welcome: "Bem-vindo de volta!",
        select_provider: "Selecione um provedor de LLM:",
        enter_api_key: "Digite sua API Key para",
        select_model: "Selecione um modelo:",
        loading_models: "Carregando modelos do Ollama...",
        no_models_found: "Nenhum modelo encontrado.",
        press_enter_to_continue: "Pressione Enter para continuar",
        thinking: "Pensando",
        searching: "Buscando",
        error: "Erro",
        confirm_action: "Permitir que o agente execute esta ferramenta?",
        yes: "Sim",
        no: "Não",
        allow_all: "Sim, permitir tudo nesta sessão",
        shortcuts_help: "? para atalhos",
        effort: "esforço",
        focus: "foco",
        react: "react",
        advisor: "consultor",
        language_selection: "Selecione o idioma da interface:",
        config_saved: "Configuração salva com sucesso.",
    },
    hi: {
        welcome: "वापसी पर स्वागत है!",
        select_provider: "LLM प्रदाता चुनें:",
        enter_api_key: "इसके लिए API कुंजी दर्ज करें",
        select_model: "एक मॉडल चुनें:",
        loading_models: "Ollama मॉडल लोड हो रहे हैं...",
        no_models_found: "कोई मॉडल नहीं मिला।",
        press_enter_to_continue: "जारी रखने के लिए एंटर दबाएं",
        thinking: "सोच रहा है",
        searching: "खोज रहा है",
        error: "त्रुटि",
        confirm_action: "क्या एजेंट को इस टूल को चलाने की अनुमति है?",
        yes: "हाँ",
        no: "नहीं",
        allow_all: "हाँ, इस सत्र के लिए सभी की अनुमति दें",
        shortcuts_help: "शॉर्टकट के लिए ?",
        effort: "प्रयास",
        focus: "फोकस",
        react: "प्रतिक्रिया",
        advisor: "सलाहकार",
        language_selection: "इंटरफ़ेस भाषा चुनें:",
        config_saved: "कॉन्फ़िगरेशन सफलतापूर्वक सहेजा गया।",
    },
    fr: {
        welcome: "Bon retour !",
        select_provider: "Sélectionnez un fournisseur de LLM :",
        enter_api_key: "Entrez votre clé API pour",
        select_model: "Sélectionnez un modèle :",
        loading_models: "Chargement des modèles Ollama...",
        no_models_found: "Aucun modèle trouvé.",
        press_enter_to_continue: "Appuyez sur Entrée pour continuer",
        thinking: "Réflexion",
        searching: "Recherche",
        error: "Erreur",
        confirm_action: "Autoriser l'agent à exécuter cet outil ?",
        yes: "Oui",
        no: "Non",
        allow_all: "Oui, tout autoriser pour cette session",
        shortcuts_help: "? pour les raccourcis",
        effort: "effort",
        focus: "focus",
        react: "réaction",
        advisor: "conseiller",
        language_selection: "Sélectionnez la langue de l'interface :",
        config_saved: "Configuration enregistrée avec succès.",
    }
};

let currentLang = 'en';

export function setLanguage(lang) {
    if (translations[lang]) {
        currentLang = lang;
    }
}

export function t(key) {
    return translations[currentLang]?.[key] || translations['en'][key] || key;
}

export function getCurrentLanguage() {
    return currentLang;
}

export function getAvailableLanguages() {
    return Object.keys(translations);
}

export function loadLanguageFromConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            if (config.language) {
                setLanguage(config.language);
            }
        }
    } catch (e) {
        // Silently fail
    }
}

loadLanguageFromConfig();
