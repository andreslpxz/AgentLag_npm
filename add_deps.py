import json

with open('package.json', 'r') as f:
    data = json.load(f)

data['dependencies']['@langchain/google-genai'] = 'latest'
data['dependencies']['@langchain/cohere'] = 'latest'

with open('package.json', 'w') as f:
    json.dump(data, f, indent=2)
