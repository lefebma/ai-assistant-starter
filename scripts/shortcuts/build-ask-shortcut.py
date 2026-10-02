#!/usr/bin/env python3
"""
Build the generic "Ask Havn" Apple Shortcut (card #152).

One file serves every owner: it carries no address and no key. On import,
Shortcuts asks two questions (paste the address, paste the key line) and
fills them in, so the owner never opens the editor.

Unsigned output is not importable on iOS. Sign it on a Mac:

  python3 scripts/shortcuts/build-ask-shortcut.py /tmp/ask-unsigned.shortcut
  shortcuts sign --mode anyone --input /tmp/ask-unsigned.shortcut \
    --output "templates/shortcuts/Ask Havn.shortcut"

Pass --address/--key to bake both in instead (for testing on this Mac with
`shortcuts run`, never for a file that leaves the machine).
"""
import argparse
import plistlib
import uuid

OBJ = '￼'  # the placeholder a variable occupies inside a text field


def text(s):
    return {'Value': {'string': s}, 'WFSerializationType': 'WFTextTokenString'}


def var(output_uuid, output_name):
    return {
        'Value': {
            'string': OBJ,
            'attachmentsByRange': {
                '{0, 1}': {'OutputUUID': output_uuid, 'Type': 'ActionOutput', 'OutputName': output_name}
            },
        },
        'WFSerializationType': 'WFTextTokenString',
    }


def dict_field(items):
    return {
        'Value': {
            'WFDictionaryFieldValueItems': [
                {'WFItemType': 0, 'WFKey': text(k), 'WFValue': v} for k, v in items
            ]
        },
        'WFSerializationType': 'WFDictionaryFieldValue',
    }


def build(address='', key=''):
    u_key, u_addr, u_ask, u_get = (str(uuid.uuid4()).upper() for _ in range(4))
    actions = [
        {
            'WFWorkflowActionIdentifier': 'is.workflow.actions.gettext',
            'WFWorkflowActionParameters': {'UUID': u_key, 'WFTextActionText': key, 'CustomOutputName': 'Key'},
        },
        {
            'WFWorkflowActionIdentifier': 'is.workflow.actions.gettext',
            'WFWorkflowActionParameters': {'UUID': u_addr, 'WFTextActionText': address, 'CustomOutputName': 'Address'},
        },
        {
            'WFWorkflowActionIdentifier': 'is.workflow.actions.ask',
            'WFWorkflowActionParameters': {'UUID': u_ask, 'WFAskActionPrompt': 'What do you need?', 'WFInputType': 'Text'},
        },
        {
            'WFWorkflowActionIdentifier': 'is.workflow.actions.downloadurl',
            'WFWorkflowActionParameters': {
                'UUID': u_get,
                'WFURL': var(u_addr, 'Address'),
                'WFHTTPMethod': 'POST',
                'ShowHeaders': True,
                'WFHTTPHeaders': dict_field([('Authorization', var(u_key, 'Key'))]),
                'WFHTTPBodyType': 'JSON',
                'WFJSONValues': dict_field([('text', var(u_ask, 'Provided Input'))]),
            },
        },
        {
            'WFWorkflowActionIdentifier': 'is.workflow.actions.showresult',
            'WFWorkflowActionParameters': {'Text': var(u_get, 'Contents of URL')},
        },
    ]
    questions = [] if (address or key) else [
        {
            'ActionIndex': 0,
            'Category': 'Parameter',
            'ParameterKey': 'WFTextActionText',
            'DefaultValue': '',
            'Text': 'Paste the key from your chat: the last message, the line that starts with Bearer.',
        },
        {
            'ActionIndex': 1,
            'Category': 'Parameter',
            'ParameterKey': 'WFTextActionText',
            'DefaultValue': '',
            'Text': 'Paste the address from your chat: the message that starts with https.',
        },
    ]
    return {
        'WFWorkflowActions': actions,
        'WFWorkflowClientVersion': '2607.0.2',
        'WFWorkflowMinimumClientVersion': 900,
        'WFWorkflowMinimumClientVersionString': '900',
        'WFWorkflowIcon': {'WFWorkflowIconGlyphNumber': 59511, 'WFWorkflowIconStartColor': 463140863},
        'WFWorkflowImportQuestions': questions,
        'WFWorkflowInputContentItemClasses': ['WFStringContentItem'],
        'WFWorkflowOutputContentItemClasses': [],
        'WFWorkflowTypes': ['Watch', 'ActionExtension'],
        'WFQuickActionSurfaces': [],
        'WFWorkflowHasShortcutInputVariables': False,
        'WFWorkflowHasOutputFallback': False,
    }


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('output')
    ap.add_argument('--address', default='')
    ap.add_argument('--key', default='')
    a = ap.parse_args()
    with open(a.output, 'wb') as f:
        plistlib.dump(build(a.address, a.key), f, fmt=plistlib.FMT_BINARY)
