#!/usr/bin/python3
"""Builds the "Save to Offline Reader" iOS/macOS shortcut.

    python3 build_shortcut.py OWNER OUT.shortcut   (unsigned)
    shortcuts sign --mode anyone --input OUT.shortcut --output "Save to Offline Reader.shortcut"

The GitHub token is not stored in the file: Shortcuts asks for it when the shortcut is added
(an "import question" on the first action).

Share a link, web page or PDF to it → it uploads to queue/ in the library repo, which triggers
the processing Action.
"""
import plistlib
import sys
import uuid

OWNER = sys.argv[1] if len(sys.argv) > 1 else "rayman239"
OUT = sys.argv[2] if len(sys.argv) > 2 else "unsigned.shortcut"
API = f"https://api.github.com/repos/{OWNER}/offline-reader-library/contents/queue/"
OBJ = "￼"  # placeholder character where a variable sits inside text


def uid():
    return str(uuid.uuid4()).upper()


# ---------- value builders ----------

def var(name):
    return {"Type": "Variable", "VariableName": name}


def out(action, name):
    return {"Type": "ActionOutput", "OutputUUID": action["WFWorkflowActionParameters"]["UUID"], "OutputName": name}


INPUT = {"Type": "ExtensionInput"}


def text(*parts):
    """Text with embedded variables: text("Bearer ", var("Token"))."""
    s, attachments = "", {}
    for p in parts:
        if isinstance(p, str):
            s += p
        else:
            pos = len(s.encode("utf-16-le")) // 2
            attachments[f"{{{pos}, 1}}"] = p
            s += OBJ
    return {"Value": {"string": s, "attachmentsByRange": attachments}, "WFSerializationType": "WFTextTokenString"}


def attach(v):
    return {"Value": v, "WFSerializationType": "WFTextTokenAttachment"}


def dictionary(pairs):
    return {
        "Value": {"WFDictionaryFieldValueItems": [
            {"WFItemType": 0, "WFKey": text(k), "WFValue": v if isinstance(v, dict) else text(v)} for k, v in pairs
        ]},
        "WFSerializationType": "WFDictionaryFieldValue",
    }


def action(ident, **params):
    params.setdefault("UUID", uid())
    return {"WFWorkflowActionIdentifier": f"is.workflow.actions.{ident}", "WFWorkflowActionParameters": params}


def cond_start(group, input_value, condition, string=None):
    p = {"GroupingIdentifier": group, "WFControlFlowMode": 0, "WFCondition": condition, "WFInput": {
        "Type": "Variable", "Variable": attach(input_value)}}
    if string is not None:
        p["WFConditionalActionString"] = string
    return action("conditional", **p)


def cond_else(group):
    return action("conditional", GroupingIdentifier=group, WFControlFlowMode=1)


def cond_end(group):
    return action("conditional", GroupingIdentifier=group, WFControlFlowMode=2)


def put(url_text, message, content_action):
    return action(
        "downloadurl",
        WFURL=url_text,
        WFHTTPMethod="PUT",
        ShowHeaders=True,
        WFHTTPHeaders=dictionary([
            ("Authorization", text("Bearer ", var("Token"))),
            ("Accept", "application/vnd.github+json"),
            ("X-GitHub-Api-Version", "2022-11-28"),
        ]),
        WFHTTPBodyType="JSON",
        WFJSONValues=dictionary([
            ("message", message),
            ("content", text(out(content_action, "Base64 Encoded"))),
        ]),
    )


# ---------- the shortcut ----------

IS, HAS_ANY_VALUE = 4, 100

token = action("gettext", WFTextActionText=text("PASTE-YOUR-TOKEN"))
set_token = action("setvariable", WFVariableName="Token", WFInput=attach(out(token, "Text")))
stamp = action("format.date", WFDateFormatStyle="Custom", WFDateFormat="yyyyMMdd'T'HHmmss",
               WFDate=text({"Type": "CurrentDate"}))
set_stamp = action("setvariable", WFVariableName="Stamp", WFInput=attach(out(stamp, "Formatted Date")))
ext = action("properties.files", WFInput=attach(INPUT), WFContentItemPropertyName="File Extension")
g1 = uid()
if_pdf = cond_start(g1, out(ext, "File Extension"), IS, "pdf")
# PDF branch
pdf_b64 = action("base64encode", WFInput=attach(INPUT), WFEncodeMode="Encode", WFBase64LineBreakMode="None")
pdf_name = action("getitemname", WFInput=attach(INPUT))
pdf_name_enc = action("urlencode", WFInput=text(out(pdf_name, "Name")), WFEncodeMode="Encode")
pdf_put = put(text(API, var("Stamp"), "--", out(pdf_name_enc, "URL Encoded Text"), ".pdf"), "Save PDF", pdf_b64)
otherwise = cond_else(g1)
# Link branch
# Send whatever links Shortcuts detects plus the shared text; the processor picks out the address.
# (Apps share links in different shapes — a URL, a web page, or a sentence containing a link.)
links = action("detect.link", WFInput=attach(INPUT))
shared = action("detect.text", WFInput=attach(INPUT))
body = action("gettext", WFTextActionText=text(out(links, "URLs"), "\n", out(shared, "Text")))
link_b64 = action("base64encode", WFInput=attach(out(body, "Text")), WFEncodeMode="Encode", WFBase64LineBreakMode="None")
link_put = put(text(API, var("Stamp"), ".txt"), "Save link", link_b64)
end_if = cond_end(g1)

commit = action("getvalueforkey", WFInput=attach(out(end_if, "If Result")), WFDictionaryKey="commit",
                WFGetDictionaryValueType="Value")
err = action("getvalueforkey", WFInput=attach(out(end_if, "If Result")), WFDictionaryKey="message",
             WFGetDictionaryValueType="Value")
g2 = uid()
ok_if = cond_start(g2, out(commit, "Dictionary Value"), HAS_ANY_VALUE)
ok_note = action("notification", WFNotificationActionTitle="Offline Reader",
                 WFNotificationActionBody=text("Saved — it'll be ready to read in a minute or two."),
                 WFNotificationActionSound=False)
ok_else = cond_else(g2)
bad_note = action("notification", WFNotificationActionTitle="Offline Reader — not saved",
                  WFNotificationActionBody=text("GitHub said: ", out(err, "Dictionary Value"),
                                                ". Check the token in this shortcut."))
ok_end = cond_end(g2)

actions = [token, set_token, stamp, set_stamp, ext,
           if_pdf, pdf_b64, pdf_name, pdf_name_enc, pdf_put,
           otherwise, links, shared, body, link_b64, link_put, end_if,
           commit, err, ok_if, ok_note, ok_else, bad_note, ok_end]

shortcut = {
    "WFWorkflowClientVersion": "2302.0.4",
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowIcon": {"WFWorkflowIconStartColor": 463140863, "WFWorkflowIconGlyphNumber": 59511},
    "WFWorkflowTypes": ["ActionExtension"],
    "WFWorkflowInputContentItemClasses": [
        "WFURLContentItem", "WFSafariWebPageContentItem", "WFPDFContentItem",
        "WFGenericFileContentItem", "WFStringContentItem",
    ],
    "WFWorkflowHasShortcutInputVariables": True,
    "WFWorkflowNoInputBehavior": {"Name": "WFWorkflowNoInputBehaviorGetClipboard", "Parameters": {}},
    "WFWorkflowImportQuestions": [{
        "ActionIndex": 0,
        "Category": "Parameter",
        "ParameterKey": "WFTextActionText",
        "Text": "Paste your GitHub token (the same github_pat_… key you used to set up the app):",
        "DefaultValue": "",
    }],
    "WFWorkflowActions": actions,
}

with open(OUT, "wb") as f:
    plistlib.dump(shortcut, f, fmt=plistlib.FMT_BINARY)
print(f"wrote {OUT} ({len(actions)} actions)")
