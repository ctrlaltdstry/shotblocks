// Shotblocks — C++ plugin hosting the web UI.
//
// Uses Cinema 4D 2026's built-in HtmlViewerCustomGui (CUSTOMGUI_HTMLVIEWER)
// to render the web UI inside a dockable GeDialog. Because the HTML
// viewer is a first-party C4D widget, docking, layout, and lifecycle
// all "just work" — no WebView2 hosting, no HWND walking, no parenting.
//
// JS <-> C++ bridge
// -----------------
// C++ -> JS: htmlView->PostWebMessage(...) reaches
//            window.chrome.webview.addEventListener('message', ...). Fine.
//
// JS  -> C++: BROKEN through the public SDK in C4D 2026. Both
//             SetWebMessageCallback (postMessage from JS) and
//             SetResourceRequestInterceptCallback (fetch() from JS) are
//             dead — they register cleanly but the callback never fires
//             for any URL. Diagnosis logged as the memory
//             c4d-htmlviewer-postmessage-oneway.md.
//
//             Workaround: a Winsock HTTP server on 127.0.0.1:<OS-picked>
//             runs in a worker thread inside this plugin. JS fetches
//             http://127.0.0.1:PORT/cmd. The worker pushes requests onto
//             a queue, posts SpecialEventAdd to wake the main thread,
//             then blocks until the main thread fulfills a promise with
//             the response body. The port is pushed to JS via
//             PostWebMessage on first navigate.

// Winsock must precede Windows.h so the legacy winsock.h shipped with
// <Windows.h> doesn't get pulled in and collide with winsock2.
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <Windows.h>

// Windows.h defines macros (DELETE, ERROR, GetMessage, ...) that collide
// with Maxon API names; the SDK ships an undef header for exactly this
// case. It must sit between the Windows and Maxon includes.
#include "maxon/utilities/undef_win_macros.h"

#include "c4d.h"
#include "c4d_gui.h"
#include "c4d_plugin.h"
#include "c4d_resource.h"
#include "c4d_file.h"
#include "c4d_customgui/customgui_htmlviewer.h"
#include "c4d_videopost.h"
#include "c4d_libs/lib_batchrender.h"
#include "c4d_libs/lib_takesystem.h"
#include "description/drendersettings.h"
#include "description/dbasedraw.h"

#include <stdio.h>

#include <atomic>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <deque>
#include <functional>
#include <future>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <unordered_map>

#include <commctrl.h>  // SetWindowSubclass — for the dialog WM_SETCURSOR hook
#include <shellapi.h>  // ShellExecuteW — open the bundled user manual in the OS browser

#pragma comment(lib, "Ws2_32.lib")
#pragma comment(lib, "Comctl32.lib")

using namespace cinema;

static const Int32 g_shotblocks_cmd_id = 1000007;

// Plan 4.1 commit 3 — Stage Driver tag plugin id. Hidden tag attached
// to the hidden Stage helper; receives MSG_MULTI_RENDERNOTIFICATION
// to toggle the Stage's enable flag around renders + writes the
// Stage's static STAGEOBJECT_CLINK per render-frame.
static const Int32 g_shotblocks_stage_driver_id = 1000008;

// Custom CoreMessage id the HTTP worker uses to wake the main thread.
// We piggyback the plugin id so dialog instances filter their own work.
static const Int32 g_sb_msg_http_request = g_shotblocks_cmd_id;

static const Int32 ID_HOST_GROUP    = 2000;
static const Int32 ID_HOST_HTMLVIEW = 2001;


// -----------------------------------------------------------------------------
// Compute the inclusive [first, last] keyframe range of a BaseObject.
// Walks the flat CTrack list (vector params like position/rotation are
// already split into per-component CTracks in this list, no recursion
// needed for the camera case). Also walks tags so the v1 shotblocks
// rig — which animates via expression tags — surfaces its keys.
//
// Returns true and fills `outFirst` / `outLast` (in frames) if any
// animation was found, false otherwise.
// -----------------------------------------------------------------------------
static Bool GetAnimatedFrameRange(BaseObject* op, Int32 fps,
                                  Int32* outFirst, Int32* outLast)
{
	if (!op)
		return false;
	BaseTime first = BaseTime(1.0e30);
	BaseTime last  = BaseTime(-1.0e30);
	Bool found = false;

	auto visitTracks = [&](CTrack* head) {
		for (CTrack* t = head; t; t = t->GetNext())
		{
			CCurve* c = t->GetCurve(CCURVE::CURVE, false);
			if (!c || c->GetKeyCount() == 0)
				continue;
			BaseTime s = c->GetStartTime();
			BaseTime e = c->GetEndTime();
			if (s < first)
				first = s;
			if (e > last)
				last = e;
			found = true;
		}
	};
	// Animation contributing to a camera can live in three places:
	//   1) The camera itself — object tracks + tag tracks (an Align to
	//      Spline tag drives position via tag tracks, not object tracks).
	//   2) Child objects under the camera — v1 rig has constraint nulls
	//      below the camera whose tracks drive its pose.
	//   3) Parent objects above the camera — a camera parented under
	//      an animated null inherits the null's transform. Walk the
	//      parent chain up to the document root; each parent's own
	//      tracks AND tag tracks count.
	auto visitObject = [&](BaseObject* o) {
		visitTracks(o->GetFirstCTrack());
		for (BaseTag* tag = o->GetFirstTag(); tag; tag = tag->GetNext())
			visitTracks(tag->GetFirstCTrack());
	};
	visitObject(op);
	// Descend into children (recursive — a v1 rig may have nested nulls).
	auto visitTree = [&](BaseObject* o, auto& self) -> void {
		visitObject(o);
		for (BaseObject* ch = o->GetDown(); ch; ch = ch->GetNext())
			self(ch, self);
	};
	for (BaseObject* ch = op->GetDown(); ch; ch = ch->GetNext())
		visitTree(ch, visitTree);
	// Ascend the parent chain.
	for (BaseObject* p = op->GetUp(); p; p = p->GetUp())
		visitObject(p);

	if (!found)
		return false;
	*outFirst = first.GetFrame(fps);
	*outLast  = last.GetFrame(fps);
	return true;
}


// -----------------------------------------------------------------------------
// Persistence — clip data lives in a hidden helper BaseObject inserted at
// the document root, mirroring the Python plugin (sb_persistence.py). The
// helper is marked via a BaseContainer string key so we can find it again
// across save/load cycles. Per-clip camera BaseLinks are stored on the same
// helper, keyed by BASE+objectId — survives object renames in the OM and
// follows the doc through save/load.
// -----------------------------------------------------------------------------
static const Int32 BCKEY_HELPER_MARKER = 1100;   // String: identifies the helper
static const Int32 BCKEY_CLIPS_JSON    = 1101;   // String: JSON tracks + nextClipId
static const Int32 BCKEY_VERSION       = 1102;   // Int32: monotonic save version
static const Int32 BCKEY_CAM_LINK_BASE = 2100;   // BaseLink at BASE + objectId

// Known camera object plugin IDs. Add a new entry per renderer as their
// IDs become known. Standard and Redshift are documented in
// ge_prepass.h (Ocamera=5103, Orscamera=1057516). Octane / Arnold are
// not shipped with C4D — their IDs can be added here when verified on
// a machine that has them.
// See .agent/plans/v1-plan-4-camera-workflow.md (R1) for the research
// trail.
struct CameraTypeCandidate {
	Int32        id;
	const char*  defaultLabel; // shown only if BasePlugin::GetName returns empty
};
static const CameraTypeCandidate kCameraCandidates[] = {
	{ 5103,    "Standard Camera" },  // Ocamera — always available
	{ 1057516, "RS Camera"       },  // Orscamera — Redshift "New Camera Object"
};
static constexpr Int kCameraCandidateCount =
	sizeof(kCameraCandidates) / sizeof(kCameraCandidates[0]);
// Audio bytes per clip — base64-encoded original-format bytes (WAV /
// MP3) keyed by BCKEY_AUDIO_BASE + clipId. Written once on drop
// (audio-add), read on demand from JS (audio-fetch), removed on clip
// delete (audio-remove). Separate from BCKEY_CLIPS_JSON so the
// normal save-state path doesn't re-ship audio on every clip move.
static const Int32 BCKEY_AUDIO_BASE    = 3100;
static const char  HELPER_MARKER_VALUE[]  = "shotblocks_helper";
static const char  HELPER_NULL_NAME[]     = "_shotblocks";

// Plan 4.1 — hidden Stage object that drives multi-camera switching
// during render. Lives in the doc as a sibling of the persistence
// helper; hidden via NBIT_OHIDE so the user never sees it. Marked via
// the same BCKEY but with a distinct value so FindV2Helper /
// FindStageHelper don't confuse the two.
//
// During interactive use, the Stage's enable flag
// (ID_BASEOBJECT_GENERATOR_FLAG) stays FALSE — viewport routing is
// owned by JS's useActiveClipRouter via set-active-camera. A driver
// tag attached to the Stage (Commit 3) will flip the enable flag
// during MSG_MULTI_RENDERNOTIFICATION so any C4D render path (Picture
// Viewer, Render Queue, network render) honors Shotblocks sequencing.
static const char  STAGE_HELPER_MARKER_VALUE[] = "shotblocks_stage_helper";
static const char  STAGE_HELPER_NAME[]         = "_shotblocks_stage";
// The Stage marker must NOT reuse BCKEY_HELPER_MARKER (1100) — on an
// Ostage that ID IS STAGEOBJECT_CLINK (the camera-link param). Writing
// the marker string there clobbers/loses against the camera link, so
// FindStageHelper never matches and a duplicate Stage is allocated on
// every call. Use a private ID clear of all Stage params.
static const Int32 BCKEY_STAGE_MARKER = 1000900;

// Find the existing v2 helper in `doc`, or nullptr.
static BaseObject* FindV2Helper(BaseDocument* doc)
{
	if (!doc) return nullptr;
	for (BaseObject* op = doc->GetFirstObject(); op; op = op->GetNext())
	{
		BaseContainer* bc = op->GetDataInstance();
		if (!bc) continue;
		if (bc->GetString(BCKEY_HELPER_MARKER) == maxon::String(HELPER_MARKER_VALUE))
			return op;
	}
	return nullptr;
}

// Find or create the v2 helper. Hidden + display:none so it never appears
// in the Object Manager or viewport.
static BaseObject* GetOrCreateV2Helper(BaseDocument* doc)
{
	if (!doc) return nullptr;
	BaseObject* helper = FindV2Helper(doc);
	if (!helper)
	{
		helper = BaseObject::Alloc(Onull);
		if (!helper) return nullptr;
		helper->SetName(maxon::String(HELPER_NULL_NAME));
		BaseContainer* bc = helper->GetDataInstance();
		if (bc)
			bc->SetString(BCKEY_HELPER_MARKER, maxon::String(HELPER_MARKER_VALUE));
		helper->ChangeNBit(NBIT::OHIDE, NBITCONTROL::SET);
		doc->InsertObject(helper, nullptr, nullptr);
		GePrint("[Shotblocks/v2] created persistence helper"_s);
	}
	// Plan 4.1 commit 3 — ensure the camera-driver tag is attached.
	// Tag fires Execute per frame in render + native scrub + native
	// playback, routing the active camera into the BaseDraw via the
	// SetParameter recipe. Idempotent: looks for an existing tag.
	if (!helper->GetTag(g_shotblocks_stage_driver_id))
	{
		BaseTag* driver = helper->MakeTag(g_shotblocks_stage_driver_id);
		if (driver)
			GePrint("[Shotblocks/v2] attached Camera Driver tag"_s);
	}
	return helper;
}

// Plan 4.1 — find the existing hidden Stage helper in `doc`, or nullptr.
// Distinct from the persistence helper Onull (different marker value).
static BaseObject* FindStageHelper(BaseDocument* doc)
{
	if (!doc) return nullptr;
	BaseObject* byName = nullptr;
	for (BaseObject* op = doc->GetFirstObject(); op; op = op->GetNext())
	{
		if (op->GetType() != Ostage) continue;
		BaseContainer* bc = op->GetDataInstance();
		if (!bc) continue;
		if (bc->GetString(BCKEY_STAGE_MARKER) == maxon::String(STAGE_HELPER_MARKER_VALUE))
			return op;
		// Fallback: stages created before the marker-key fix stamped the
		// marker on key 1100 (== STAGEOBJECT_CLINK), which got clobbered.
		// Recognize them by name and re-stamp the correct marker.
		if (!byName && op->GetName() == maxon::String(STAGE_HELPER_NAME))
			byName = op;
	}
	if (byName)
	{
		BaseContainer* bc = byName->GetDataInstance();
		if (bc) bc->SetString(BCKEY_STAGE_MARKER, maxon::String(STAGE_HELPER_MARKER_VALUE));
	}
	return byName;
}

// Plan 4.1 — find or create the hidden Stage helper. Dormant on
// creation (ID_BASEOBJECT_GENERATOR_FLAG = false) so it doesn't
// interfere with interactive camera selection. The driver tag's
// MSG_MULTI_RENDERNOTIFICATION handler flips it on for renders.
// Hidden via NBIT::OHIDE so it doesn't appear in the OM.
//
// Commit 3 addition: ensures the Stage Driver tag is attached. The
// driver receives MSG_MULTI_RENDERNOTIFICATION + ticks Execute per
// frame to write the right camera into Stage's STAGEOBJECT_CLINK.
static BaseObject* GetOrCreateStageHelper(BaseDocument* doc)
{
	if (!doc) return nullptr;
	BaseObject* stage = FindStageHelper(doc);
	// Remove any stray duplicate Stage helpers (from the pre-fix marker
	// collision, which spawned a new Stage on every call).
	if (stage)
	{
		BaseObject* op = doc->GetFirstObject();
		while (op)
		{
			BaseObject* next = op->GetNext();
			if (op != stage && op->GetType() == Ostage &&
				op->GetName() == maxon::String(STAGE_HELPER_NAME))
			{
				op->Remove();
				BaseObject::Free(op);
			}
			op = next;
		}
		// Ensure a previously-visible Stage (created during the visible
		// render test) gets hidden on next access.
		stage->ChangeNBit(NBIT::OHIDE, NBITCONTROL::SET);
	}
	if (!stage)
	{
		stage = BaseObject::Alloc(Ostage);
		if (!stage) return nullptr;
		stage->SetName(maxon::String(STAGE_HELPER_NAME));
		BaseContainer* bc = stage->GetDataInstance();
		if (bc)
			bc->SetString(BCKEY_STAGE_MARKER, maxon::String(STAGE_HELPER_MARKER_VALUE));
		// Dormant by default — viewport stays free for manual camera
		// navigation during editing. The driver tag's
		// MSG_MULTI_RENDERNOTIFICATION handler flips Enable ON for the
		// duration of a render (which fires before the renderer snapshots
		// the scene), then back OFF when the render ends.
		stage->SetParameter(
			ConstDescIDLevel(ID_BASEOBJECT_GENERATOR_FLAG),
			GeData(false), DESCFLAGS_SET::NONE);
		// Hidden from the OM — the user never sees or manages it.
		// Render switching is driven by the keyframe track + Enable
		// toggle, both independent of OM visibility, so hiding is safe.
		stage->ChangeNBit(NBIT::OHIDE, NBITCONTROL::SET);
		doc->InsertObject(stage, nullptr, nullptr);
		GePrint("[Shotblocks/v2] created Stage helper (dormant, hidden)"_s);
	}
	// Note (plan-4.1 architectural pivot 2): the camera-driver tag
	// no longer attaches to the Stage — it attaches to the helper
	// Onull instead, and routes BaseDraw::SetSceneCamera directly
	// per frame. The Stage helper is kept (idle) so the original
	// approach can be revisited if Maxon clarifies the SetParameter-
	// from-tag-on-Stage issue. See GetOrCreateV2Helper for the tag.
	return stage;
}


// -----------------------------------------------------------------------------
// Naive JSON field parsers — enough for our flat {"kind":..., "field":...}
// command bodies. Replace with a real JSON parser when message vocabulary
// outgrows it.
// -----------------------------------------------------------------------------

static Int32 ParseIntField(const std::string& body, const char* fieldName)
{
	std::string needle = std::string("\"") + fieldName + "\"";
	auto p = body.find(needle);
	if (p == std::string::npos) return 0;
	p = body.find(':', p);
	if (p == std::string::npos) return 0;
	++p;
	while (p < body.size() && (body[p] == ' ' || body[p] == '\t')) ++p;
	return (Int32)std::strtol(body.c_str() + p, nullptr, 10);
}

// Parse a quoted string value for `fieldName`. Handles standard JSON
// backslash escapes (\\ \" \n \t \r \/).
static std::string ParseStringField(const std::string& body, const char* fieldName)
{
	std::string out;
	std::string needle = std::string("\"") + fieldName + "\"";
	auto p = body.find(needle);
	if (p == std::string::npos) return out;
	p = body.find(':', p);
	if (p == std::string::npos) return out;
	p = body.find('"', p);
	if (p == std::string::npos) return out;
	++p;
	out.reserve(body.size() - p);
	while (p < body.size() && body[p] != '"')
	{
		if (body[p] == '\\' && p + 1 < body.size())
		{
			char c = body[p + 1];
			if      (c == 'n')  out += '\n';
			else if (c == 't')  out += '\t';
			else if (c == 'r')  out += '\r';
			else if (c == '"')  out += '"';
			else if (c == '\\') out += '\\';
			else if (c == '/')  out += '/';
			else                out += c;
			p += 2;
		}
		else
		{
			out += body[p++];
		}
	}
	return out;
}


// One shot parsed out of the JSON body for the individual-shots
// branch of add-to-queue. Mirrors the JS HostOutbound shape.
struct ShotIn
{
	Int32 clipId;
	Int32 objectId;
	Int32 inFrame;
	Int32 outFrame;
	std::string name;
};

// Walk the "shots":[ ... ] array of an add-to-queue body and pull
// each object's fields. The naive ParseIntField / ParseStringField
// pair only finds the first occurrence of a key; for repeated keys
// inside array elements we have to step through manually. Scoped to
// this one command so we don't have to grow the parser everywhere.
//
// Format expected (whitespace within objects is allowed):
//   "shots":[{"clipId":1,"name":"Cam A","inFrame":0,"outFrame":60,"objectId":42},...]
static std::vector<ShotIn> ParseShotsArray(const std::string& body)
{
	std::vector<ShotIn> out;
	auto p = body.find("\"shots\"");
	if (p == std::string::npos) return out;
	p = body.find('[', p);
	if (p == std::string::npos) return out;
	++p;
	while (p < body.size())
	{
		while (p < body.size() && (body[p] == ' ' || body[p] == '\t' || body[p] == ',' || body[p] == '\n' || body[p] == '\r'))
			++p;
		if (p >= body.size() || body[p] == ']')
			break;
		if (body[p] != '{')
		{
			++p;
			continue;
		}
		// Find the matching closing brace for this object. The clip
		// name is the only string we expect and it has already had its
		// JSON escapes serialized by JSON.stringify on the JS side, so
		// walking braces with a single quoted-string toggle is enough.
		Int32 depth = 0;
		auto start = p;
		Bool inStr = false;
		while (p < body.size())
		{
			char c = body[p];
			if (inStr)
			{
				if (c == '\\' && p + 1 < body.size()) p += 2;
				else
				{
					if (c == '"') inStr = false;
					++p;
				}
				continue;
			}
			if (c == '"') { inStr = true; ++p; continue; }
			if (c == '{') ++depth;
			else if (c == '}')
			{
				--depth;
				if (depth == 0) { ++p; break; }
			}
			++p;
		}
		std::string obj = body.substr(start, p - start);
		ShotIn s;
		s.clipId   = ParseIntField(obj, "clipId");
		s.objectId = ParseIntField(obj, "objectId");
		s.inFrame  = ParseIntField(obj, "inFrame");
		s.outFrame = ParseIntField(obj, "outFrame");
		s.name     = ParseStringField(obj, "name");
		out.push_back(std::move(s));
	}
	return out;
}


// -----------------------------------------------------------------------------
// Per-request work item handed from the HTTP worker thread to the main thread.
// -----------------------------------------------------------------------------
struct HttpRequest
{
	std::string body;                    // JSON request body
	std::promise<std::string> response;  // main thread fulfills with JSON body
};


// -----------------------------------------------------------------------------
// Minimal HTTP/1.0 server pinned to 127.0.0.1. One thread, blocking accept,
// one request per connection. Plenty for command-rate RPC.
// -----------------------------------------------------------------------------
class LocalHttpServer
{
public:
	using Handler = std::function<std::string(const std::string& body)>;

	LocalHttpServer() = default;
	~LocalHttpServer() { Stop(); }

	// Bind to 127.0.0.1:0, start the accept thread. Returns the bound
	// port (>0) on success, 0 on failure.
	UInt16 Start(Handler handler)
	{
		_handler = std::move(handler);

		WSADATA wsa{};
		if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0)
			return 0;

		_listen = socket(AF_INET, SOCK_STREAM, 0);
		if (_listen == INVALID_SOCKET)
		{
			WSACleanup();
			return 0;
		}

		BOOL reuse = TRUE;
		setsockopt(_listen, SOL_SOCKET, SO_REUSEADDR, (const char*)&reuse, sizeof(reuse));

		sockaddr_in addr{};
		addr.sin_family = AF_INET;
		addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK); // 127.0.0.1 only
		addr.sin_port = 0;                              // OS picks a free port

		if (bind(_listen, (sockaddr*)&addr, sizeof(addr)) == SOCKET_ERROR)
		{
			closesocket(_listen);
			_listen = INVALID_SOCKET;
			WSACleanup();
			return 0;
		}

		sockaddr_in bound{};
		int boundLen = sizeof(bound);
		if (getsockname(_listen, (sockaddr*)&bound, &boundLen) == SOCKET_ERROR)
		{
			closesocket(_listen);
			_listen = INVALID_SOCKET;
			WSACleanup();
			return 0;
		}
		_port = ntohs(bound.sin_port);

		if (listen(_listen, 8) == SOCKET_ERROR)
		{
			closesocket(_listen);
			_listen = INVALID_SOCKET;
			WSACleanup();
			return 0;
		}

		_stop.store(false);
		_thread = std::thread([this] { AcceptLoop(); });
		return _port;
	}

	void Stop()
	{
		if (_stop.exchange(true))
			return;
		if (_listen != INVALID_SOCKET)
		{
			// closesocket on the listen socket interrupts the blocking accept.
			closesocket(_listen);
			_listen = INVALID_SOCKET;
		}
		if (_thread.joinable())
			_thread.join();
		WSACleanup();
		_port = 0;
	}

	UInt16 Port() const { return _port; }

private:
	void AcceptLoop()
	{
		while (!_stop.load())
		{
			sockaddr_in client{};
			int clientLen = sizeof(client);
			SOCKET conn = accept(_listen, (sockaddr*)&client, &clientLen);
			if (conn == INVALID_SOCKET)
			{
				if (_stop.load())
					return;
				continue;
			}
			// One request per connection; handle inline. If volume grows,
			// move this to a thread pool.
			HandleConnection(conn);
			closesocket(conn);
		}
	}

	// 256 MB cap. Audio-add commands ship the full original audio
	// file as base64 (WAV stays WAV — a 5-minute stereo 44.1k WAV is
	// ~50MB raw, ~67MB base64). Save-state JSON without audio bytes
	// is still tiny (~100KB with peaks for a few clips). The cap
	// here is the per-request body limit, not the per-doc audio
	// limit. Audio bytes live in the helper's BaseContainer keyed by
	// BCKEY_AUDIO_BASE + clipId, separate from the clip JSON.
	static std::string Read(SOCKET s, size_t cap = 256 * 1024 * 1024)
	{
		std::string buf;
		buf.reserve(2048);
		char tmp[2048];
		// Read until we have headers + Content-Length-worth of body.
		size_t headerEnd = std::string::npos;
		long contentLength = 0;
		while (buf.size() < cap)
		{
			int n = recv(s, tmp, (int)sizeof(tmp), 0);
			if (n <= 0)
				break;
			buf.append(tmp, n);
			if (headerEnd == std::string::npos)
			{
				headerEnd = buf.find("\r\n\r\n");
				if (headerEnd != std::string::npos)
				{
					// Pull Content-Length if present (case-insensitive search).
					std::string headers = buf.substr(0, headerEnd);
					for (auto& c : headers)
						c = (char)std::tolower((unsigned char)c);
					auto pos = headers.find("content-length:");
					if (pos != std::string::npos)
					{
						pos += 15;
						while (pos < headers.size() && (headers[pos] == ' ' || headers[pos] == '\t'))
							++pos;
						contentLength = std::strtol(headers.c_str() + pos, nullptr, 10);
					}
				}
			}
			if (headerEnd != std::string::npos &&
				buf.size() >= headerEnd + 4 + (size_t)contentLength)
				break;
		}
		return buf;
	}

	static void Write(SOCKET s, const std::string& data)
	{
		const char* p = data.data();
		size_t left = data.size();
		while (left > 0)
		{
			int n = send(s, p, (int)left, 0);
			if (n <= 0)
				break;
			p += n;
			left -= n;
		}
	}

	void HandleConnection(SOCKET conn)
	{
		const std::string raw = Read(conn);
		if (raw.empty())
			return;

		// Parse method off the request line. We only care about OPTIONS
		// (CORS preflight) vs anything else (treated as the command POST).
		const bool isOptions = raw.compare(0, 7, "OPTIONS") == 0;

		const std::string corsHeaders =
			"Access-Control-Allow-Origin: *\r\n"
			"Access-Control-Allow-Methods: POST, OPTIONS\r\n"
			"Access-Control-Allow-Headers: Content-Type\r\n";

		if (isOptions)
		{
			const std::string resp =
				"HTTP/1.0 204 No Content\r\n" +
				corsHeaders +
				"Content-Length: 0\r\n\r\n";
			Write(conn, resp);
			return;
		}

		// Extract body after the blank line.
		std::string body;
		const auto headerEnd = raw.find("\r\n\r\n");
		if (headerEnd != std::string::npos)
			body = raw.substr(headerEnd + 4);

		std::string replyBody;
		if (_handler)
			replyBody = _handler(body);
		else
			replyBody = "{\"ok\":false,\"error\":\"no handler\"}";

		char head[256];
		_snprintf_s(head, sizeof(head), _TRUNCATE,
			"HTTP/1.0 200 OK\r\n"
			"%s"
			"Content-Type: application/json\r\n"
			"Content-Length: %zu\r\n\r\n",
			corsHeaders.c_str(),
			replyBody.size());
		Write(conn, std::string(head) + replyBody);
	}

	Handler             _handler;
	SOCKET              _listen{INVALID_SOCKET};
	UInt16              _port{0};
	std::thread         _thread;
	std::atomic<bool>   _stop{false};
};


// -----------------------------------------------------------------------------
// Dialog
// -----------------------------------------------------------------------------
class ShotblocksDialog : public GeDialog
{
public:
	// Plan 4.1 — per-clip-boundary camera event the driver tag reads
	// each render-frame. Pushed from JS via set-stage-cameras.
	struct StageCameraEvent { Int32 frame; Int32 objectId; };

	// Static accessor for the driver tag (plan-4.1 commit 3) to read
	// _stageEvents + _cameraLinks per render-frame. Set in ctor, cleared
	// in dtor; nullptr when the dialog isn't alive (renders won't switch).
	static ShotblocksDialog* GetInstance() { return s_instance; }

	ShotblocksDialog()
		: _htmlView(nullptr)
		, _navigated(false)
		, _serverStarted(false)
		, _jsHandshakeDone(false)
		, _hoverActive(false)
		, _lastTimeChangedTickMs(0)
		, _httpPort(0)
	{
		s_instance = this;
	}

	~ShotblocksDialog() override
	{
		// Stop the listener before the dialog evaporates. If we don't,
		// the accept thread can hand the main thread a request it can't
		// service.
		_server.Stop();
		if (s_instance == this) s_instance = nullptr;
	}

	// Driver-tag accessors (plan-4.1 commit 3).
	const std::vector<StageCameraEvent>& GetStageEvents() const { return _stageEvents; }
	BaseObject* ResolveCameraForObjectId(BaseDocument* doc, Int32 objectId) const
	{
		if (objectId <= 0 || !doc) return nullptr;
		auto it = _cameraLinks.find(objectId);
		if (it == _cameraLinks.end() || !it->second) return nullptr;
		// GetLink(doc) returns null during render evaluation — the link
		// is doc-scoped and render uses a different evaluation context.
		// ForceGetLink ignores the doc and returns the live target.
		BaseList2D* link = it->second->GetLink(doc);
		if (!link) link = it->second->ForceGetLink();
		return static_cast<BaseObject*>(link);
	}

private:
	static ShotblocksDialog* s_instance;

public:

	Bool CreateLayout() override
	{
		SetTitle("Shotblocks"_s);
		GroupBegin(ID_HOST_GROUP, BFH_SCALEFIT | BFV_SCALEFIT, 1, 0, ""_s, 0);
			_htmlView = AddCustomGui<HtmlViewerCustomGui>(
				ID_HOST_HTMLVIEW, ""_s, BFH_SCALEFIT | BFV_SCALEFIT,
				400, 300, BaseContainer());
		GroupEnd();
		// CreateLayout fires on every Open() — including reopens, where
		// the HTML viewer is rebuilt from scratch. Clear cached state so
		// EnsureNavigated() re-resolves and the JS-side port handshake
		// runs again.
		_htmlView = nullptr;
		_navigated = false;
		_jsHandshakeDone = false;
		SetTimer(250);
		return true;
	}

	Bool InitValues() override
	{
		SetTimer(250);
		return true;
	}

	void Timer(const BaseContainer& /*msg*/) override
	{
		EnsureNavigated();
		AnnouncePortIfReady();
		EnsureCursorSubclass();
		// Poll for render-settings drift on every tick. C4D doesn't
		// fire EVMSG_CHANGE for in-Render-Settings edits (AOV delete,
		// per-tab parameter changes); without polling the Sync button
		// only lights when the user switches the active RD or makes
		// some other doc edit. 250ms is the dialog Timer cadence —
		// fast enough for the user to never notice the lag.
		//
		// Skip during v2 playback: the drift check serializes the
		// RenderData container to fingerprint it (ComputeRenderSettings
		// Fingerprint), which is too expensive to run every frame at
		// fps cadence — it competes with the per-frame redraw and makes
		// playback stutter. The user isn't editing render settings while
		// playing, so there's nothing to detect; the poll resumes the
		// moment playback stops.
		if (!_v2Playing)
			PushRenderSettingsDrift(GetActiveDocument());
		// Playback is driven by C4D's native transport (RunAnimation),
		// NOT by advancing doc->SetTime from this Timer. The hand-rolled
		// per-frame seek couldn't redraw heavy sim/Alembic scenes
		// smoothly: plain EventAdd repainted only ~every 60 frames, and
		// forcing the redraw (ExecutePasses/DrawViews) crashed by
		// re-entering the simulation cache build. C4D's own play loop
		// evaluates sims/Alembic sequentially and redraws correctly, so
		// we hand it the transport (see toggle-play) and just mirror the
		// playhead via the EVMSG_TIMECHANGED tick. The fps-cadence Timer
		// bump is gone; this Timer stays at idle 250ms cadence.
		PostTick();

		// Loop-state poll (C4D -> ShotBlocks direction). C4D's loop is a
		// toggle command (12427 = continuous loop ON); read it cheaply
		// every tick and push to JS only when it CHANGES, so clicking
		// C4D's own loop buttons updates the ShotBlocks toggle. The
		// set-loop handler pre-writes _lastLoopChecked on the JS->C4D
		// path, so a ShotBlocks-initiated toggle doesn't echo back here.
		// _lastLoopChecked starts at -1 so the first tick always pushes
		// the current C4D state, bootstrapping the toggle on connect.
		{
			Int32 nowOn = IsCommandChecked(12427) ? 1 : 0;
			if (nowOn != _lastLoopChecked)
			{
				_lastLoopChecked = nowOn;
				if (_htmlView)
					_htmlView->PostWebMessage(maxon::String(
						nowOn ? "{\"kind\":\"loop-state\",\"enabled\":true}"
						      : "{\"kind\":\"loop-state\",\"enabled\":false}"));
			}
		}
	}

	// Object Manager → timeline drag handler.
	//
	// Lifecycle: BFM_DRAGRECEIVE fires repeatedly during hover, then
	// once more with BFM_DRAG_FINISHED on drop or BFM_DRAG_LOST on
	// cancel/out-of-area.
	//
	// Outbound to JS:
	//   om-hover  — every hover tick while over our area; carries the
	//               cursor's viewport coords + items + each item's
	//               animated frame range (so the JS ghost can match
	//               the true source duration).
	//   om-drop   — on FINISHED; same payload shape as om-hover.
	//   om-cancel — when hover state transitions from "over us" to
	//               "not over us" (drag continues elsewhere), so the
	//               ghost can disappear.
	//
	// Coord conversion (Screen2Local + GetItemDim → viewport pixels)
	// happens once and is reused for hover + drop. See memory
	// webview2-screen-coords for the rationale.
	Int32 Message(const BaseContainer& msg, BaseContainer& result) override
	{
		if (msg.GetId() != BFM_DRAGRECEIVE)
			return GeDialog::Message(msg, result);

		const Bool lost     = msg.GetBool(BFM_DRAG_LOST);
		const Bool finished = msg.GetBool(BFM_DRAG_FINISHED);

		const Bool overUs = !lost && CheckDropArea(ID_HOST_HTMLVIEW, msg, true, true);
		if (!overUs)
		{
			// Drag left our area. If we were showing a ghost, tell JS
			// to clear it. We don't track which kind of drag was in
			// flight, so post both kinds of cancel — JS clears whichever
			// ghost it had.
			if (_hoverActive && _htmlView)
			{
				_htmlView->PostWebMessage("{\"kind\":\"om-cancel\"}"_s);
				_htmlView->PostWebMessage("{\"kind\":\"file-cancel\"}"_s);
			}
			_hoverActive = false;
			return 0;
		}

		Int32 type = 0;
		void* obj  = nullptr;
		GetDragObject(msg, &type, &obj);
		if (!obj)
			return 0;

		// Coord conversion: screen → dialog-local → HtmlViewer-viewport.
		// Same for every drag type; do it once.
		Int32 sx = msg.GetInt32(BFM_DRAG_SCREENX);
		Int32 sy = msg.GetInt32(BFM_DRAG_SCREENY);
		Screen2Local(&sx, &sy);
		Int32 hvX = 0, hvY = 0, hvW = 0, hvH = 0;
		if (GetItemDim(ID_HOST_HTMLVIEW, &hvX, &hvY, &hvW, &hvH))
		{
			sx -= hvX;
			sy -= hvY;
		}

		// File drags (Explorer / C4D content browser) take a separate
		// path — payload is a filename string, not an AtomArray. Audio
		// files (.wav / .mp3) land on audio lanes via HTML5 Audio for
		// duration; everything else is silently rejected.
		if (type == DRAGTYPE_FILES ||
		    type == DRAGTYPE_FILENAME_OTHER ||
		    type == DRAGTYPE_FILENAME_IMAGE ||
		    type == DRAGTYPE_FILENAME_SCENE)
		{
			Filename* fn = static_cast<Filename*>(obj);
			if (!fn) return 0;
			String pathStr = fn->GetString();
			// Lowercase-extension audio filter. C4D's Filename gives us
			// the suffix but we want a case-insensitive compare.
			String suffix = fn->GetSuffix();
			Char* sx_c = suffix.GetCStringCopy();
			std::string ext = sx_c ? sx_c : "";
			if (sx_c) DeleteMem(sx_c);
			for (auto& c : ext) c = (char)std::tolower((unsigned char)c);
			if (ext != "wav" && ext != "mp3")
			{
				// Non-audio file drag — drop it. (Eventually images /
				// scenes will route elsewhere, but for now they're not
				// our business.)
				if (_hoverActive && _htmlView)
					_htmlView->PostWebMessage("{\"kind\":\"file-cancel\"}"_s);
				_hoverActive = false;
				return 0;
			}

			// Convert to UTF-8 + escape for JSON embedding.
			Char* pc = pathStr.GetCStringCopy();
			std::string pathUtf8 = pc ? pc : "";
			if (pc) DeleteMem(pc);
			std::string escPath;
			escPath.reserve(pathUtf8.size() + 8);
			for (char c : pathUtf8)
			{
				if      (c == '\\') escPath += "\\\\";
				else if (c == '"')  escPath += "\\\"";
				else if (c == '\n') escPath += "\\n";
				else if (c == '\r') escPath += "\\r";
				else if (c == '\t') escPath += "\\t";
				else                escPath += c;
			}

			const char* kindStr = finished ? "file-drop" : "file-hover";
			char head[256];
			_snprintf_s(head, sizeof(head), _TRUNCATE,
				"{\"kind\":\"%s\",\"viewportX\":%d,\"viewportY\":%d,\"path\":\"",
				kindStr, (int)sx, (int)sy);
			maxon::String payload = maxon::String(head)
				+ maxon::String(escPath.c_str())
				+ "\"}"_s;
			if (_htmlView)
				_htmlView->PostWebMessage(payload);

			if (finished)
			{
				_hoverActive = false;
				GePrint("[Shotblocks/v2] file-drop posted: "_s + payload);
			}
			else
			{
				_hoverActive = true;
			}
			return SetDragDestination(MOUSE_POINT_HAND);
		}

		if (type != DRAGTYPE_ATOMARRAY)
			return 0;
		AtomArray* arr = static_cast<AtomArray*>(obj);
		if (arr->GetCount() == 0)
			return 0;

		// Build the items array. Per-item: type, name, animated-range,
		// and (on FINISHED only) an objectId that JS keeps around to
		// later request camera switching via set-active-camera. We only
		// allocate the link on FINISHED so hover-only previews don't
		// leak entries into _cameraLinks.
		BaseDocument* doc = GetActiveDocument();
		const Int32 fps = doc ? doc->GetFps() : 30;
		maxon::String items("["_s);
		for (Int32 i = 0; i < arr->GetCount(); ++i)
		{
			C4DAtom* atom = arr->GetIndex(i);
			BaseList2D* b2 = static_cast<BaseList2D*>(atom);
			if (!b2)
				continue;
			if (i > 0)
				items += ","_s;

			Int32 objectId = 0;
			if (finished && b2->IsInstanceOf(Obase) && doc)
			{
				BaseObject* op = static_cast<BaseObject*>(b2);
				objectId = _nextObjectId++;
				AutoAlloc<BaseLink> link;
				if (link)
				{
					link->SetLink(op);
					_cameraLinks.emplace(objectId, std::move(link));
				}
			}

			char hdr[160];
			_snprintf_s(hdr, sizeof(hdr), _TRUNCATE,
				"{\"type\":%d,\"objectId\":%d,\"name\":\"",
				(int)b2->GetType(), (int)objectId);
			items += maxon::String(hdr);
			items += b2->GetName();
			// Animated range if present. Only BaseObjects (3D objects)
			// have keyframes worth walking; other BaseList2Ds skip.
			Int32 firstFrame = 0, lastFrame = 0;
			Bool hasAnim = false;
			if (b2->IsInstanceOf(Obase))
			{
				BaseObject* op = static_cast<BaseObject*>(b2);
				hasAnim = GetAnimatedFrameRange(op, fps, &firstFrame, &lastFrame);
			}
			char tail[128];
			if (hasAnim)
			{
				_snprintf_s(tail, sizeof(tail), _TRUNCATE,
					"\",\"hasAnim\":true,\"inFrame\":%d,\"outFrame\":%d}",
					(int)firstFrame, (int)lastFrame);
			}
			else
			{
				_snprintf_s(tail, sizeof(tail), _TRUNCATE, "\",\"hasAnim\":false}");
			}
			items += maxon::String(tail);
		}
		items += "]"_s;

		const char* kind = finished ? "om-drop" : "om-hover";
		char head[256];
		_snprintf_s(head, sizeof(head), _TRUNCATE,
			"{\"kind\":\"%s\",\"viewportX\":%d,\"viewportY\":%d,\"items\":",
			kind, (int)sx, (int)sy);
		maxon::String payload = maxon::String(head) + items + "}"_s;
		if (_htmlView)
			_htmlView->PostWebMessage(payload);

		if (finished)
		{
			_hoverActive = false;
			GePrint("[Shotblocks/v2] om-drop posted: "_s + payload);
		}
		else
		{
			_hoverActive = true;
		}
		return SetDragDestination(MOUSE_POINT_HAND);
	}

	Bool CoreMessage(Int32 id, const BaseContainer& msg) override
	{
		if (id == EVMSG_TIMECHANGED)
		{
			_lastTimeChangedTickMs = GeGetMilliSeconds();
			PostTick();
		}
		else if (id == EVMSG_CHANGE)
		{
			CheckForExternalStateChange();
			// Also re-publish doc-info so JS picks up any
			// out-of-band edits to the loop range (e.g. user dragged
			// C4D's native in/out markers in the timeline header).
			PostDocInfo();
			// Re-resolve every camera BaseLink. The OM may have changed
			// (camera deleted -> clip is now orphan; camera renamed ->
			// clip label needs to update). PostCameras ships the current
			// {alive, name} for every objectId we know about; JS derives
			// orphan status + live label from this.
			PostCameras();
			// Check the master Render Settings against the last
			// snapshot taken at Add-to-Queue / Sync. Drift → light the
			// Sync button in the Inspector.
			PushRenderSettingsDrift(GetActiveDocument());
		}
		else if (id == g_sb_msg_http_request)
		{
			DrainHttpQueue();
		}
		return GeDialog::CoreMessage(id, msg);
	}

	// Compare the helper's version counter against what we last wrote /
	// loaded. A mismatch means C4D's undo system rolled the helper to
	// a different snapshot (Ctrl+Z / Ctrl+Y on a save-state record);
	// JS needs to reload. PostWebMessage is one-way; JS handles the
	// message by re-firing load-state.
	void CheckForExternalStateChange()
	{
		BaseDocument* doc = GetActiveDocument();
		if (!doc) return;
		BaseObject* helper = FindV2Helper(doc);
		if (!helper) return;
		BaseContainer* bc = helper->GetDataInstance();
		if (!bc) return;
		const Int32 curVersion = bc->GetInt32(BCKEY_VERSION);
		if (curVersion == _lastSeenVersion) return;
		_lastSeenVersion = curVersion;
		if (_htmlView && _navigated)
			_htmlView->PostWebMessage("{\"kind\":\"state-changed\"}"_s);
	}

private:
	// ------- Navigation + JS server-port handshake -------

	void EnsureNavigated()
	{
		if (_navigated)
			return;
		if (!_htmlView)
			_htmlView = static_cast<HtmlViewerCustomGui*>(
				FindCustomGui(ID_HOST_HTMLVIEW, CUSTOMGUI_HTMLVIEWER));
		if (!_htmlView)
			return;

		// Bring up the HTTP listener exactly once for the lifetime of
		// this dialog instance. Server is per-dialog, not per-document.
		StartServerIfNeeded();

		// Build a file:// URL pointing at web/index.html sitting next
		// to the plugin DLL.
		HMODULE hMod = nullptr;
		GetModuleHandleExW(
			GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
			GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
			(LPCWSTR)&ShotblocksDialog::DispatchHttpStatic,
			&hMod);
		wchar_t dll[MAX_PATH] = {0};
		GetModuleFileNameW(hMod, dll, MAX_PATH);
		wchar_t* lastSlash = wcsrchr(dll, L'\\');
		if (lastSlash)
			*(lastSlash + 1) = 0;
		wchar_t urlBuf[MAX_PATH + 64];
		swprintf_s(urlBuf, MAX_PATH + 64, L"file:///%sweb/index.html", dll);
		for (wchar_t* p = urlBuf + 8; *p; ++p)
			if (*p == L'\\')
				*p = L'/';
		char utf8[MAX_PATH + 64] = {0};
		WideCharToMultiByte(CP_UTF8, 0, urlBuf, -1, utf8, sizeof(utf8), nullptr, nullptr);
		maxon::String url(utf8);
		_htmlView->SetUrl(url, URL_ENCODING_UTF16);
		_navigated = true;
		GePrint("[Shotblocks/v2] navigated to "_s + url);
	}

	void StartServerIfNeeded()
	{
		if (_serverStarted)
			return;
		_serverStarted = true;
		_httpPort = _server.Start([this](const std::string& body) {
			// Hop onto the main thread. We push a request, wake C4D, and
			// block until the main thread fulfills the promise.
			HttpRequest req;
			req.body = body;
			std::future<std::string> fut = req.response.get_future();
			{
				std::lock_guard<std::mutex> lk(_queueMu);
				_queue.emplace_back(std::move(req));
			}
			SpecialEventAdd(g_sb_msg_http_request, 0, 0);
			// 2s ceiling defends against the dialog being torn down with
			// an in-flight request — the future would otherwise wait
			// forever. JS sees a timeout, which is the correct signal.
			if (fut.wait_for(std::chrono::seconds(2)) == std::future_status::ready)
				return fut.get();
			return std::string("{\"ok\":false,\"error\":\"timeout\"}");
		});
		if (_httpPort != 0)
		{
			char buf[128];
			_snprintf_s(buf, sizeof(buf), _TRUNCATE,
				"[Shotblocks/v2] HTTP listener on 127.0.0.1:%u", (unsigned)_httpPort);
			GePrint(maxon::String(buf));
		}
		else
		{
			GePrint("[Shotblocks/v2] HTTP listener FAILED to start"_s);
		}
	}

	void AnnouncePortIfReady()
	{
		if (_jsHandshakeDone || !_navigated || _httpPort == 0 || !_htmlView)
			return;
		// Repeat the hello on every Timer tick until JS proves it heard
		// it (by making any HTTP call). The page-load and listener-wired
		// moments don't have a clean handshake we can observe from C++,
		// so we just keep talking until the other side answers.
		char buf[128];
		_snprintf_s(buf, sizeof(buf), _TRUNCATE,
			"{\"kind\":\"hello\",\"port\":%u}", (unsigned)_httpPort);
		_htmlView->PostWebMessage(maxon::String(buf));
	}

	// ------- Main-thread queue drain -------

	void DrainHttpQueue()
	{
		while (true)
		{
			HttpRequest req;
			{
				std::lock_guard<std::mutex> lk(_queueMu);
				if (_queue.empty())
					return;
				req = std::move(_queue.front());
				_queue.pop_front();
			}
			req.response.set_value(Dispatch(req.body));
		}
	}

	// Single-place command dispatch. Inputs/outputs are JSON strings.
	std::string Dispatch(const std::string& body)
	{
		// Any successful request proves JS heard the hello. Stop spamming.
		_jsHandshakeDone = true;
		// Cheap substring routing for now. Once command count grows we
		// can pull in a real JSON parser; for ping/click/drag-frame the
		// pattern stays trivial.
		if (body.find("\"kind\":\"ping\"") != std::string::npos)
		{
			GePrint("[Shotblocks/v2] ping received, replying with doc-info"_s);
			PostDocInfo();
			PostTick();
			PostCameras();
			return "{\"ok\":true,\"kind\":\"pong\"}";
		}
		if (body.find("\"kind\":\"set-cursor-mode\"") != std::string::npos)
		{
			HandleSetCursorMode(body);
			return "{\"ok\":true,\"kind\":\"set-cursor-mode-ack\"}";
		}
		if (body.find("\"kind\":\"tool\"") != std::string::npos)
		{
			// Tool palette selection. Body: {"kind":"tool","id":"<name>"}.
			// We just record + log for now — no behavior is wired to the
			// active tool yet.
			std::string id = ParseStringField(body, "id");
			_activeTool = id;
			GePrint("[Shotblocks/v2] tool="_s + maxon::String(id.c_str()));
			return "{\"ok\":true,\"kind\":\"tool-ack\"}";
		}
		if (body.find("\"kind\":\"seek\"") != std::string::npos)
		{
			// Scrub from JS. Body shape: {"kind":"seek","frame":<int>}.
			// Pull the integer after `"frame":`. Naive parse is enough for
			// the one numeric field; replace with a real JSON parser when
			// the message vocabulary grows beyond a handful of commands.
			Int32 frame = 0;
			auto pos = body.find("\"frame\"");
			if (pos != std::string::npos)
			{
				pos = body.find(':', pos);
				if (pos != std::string::npos)
				{
					++pos;
					while (pos < body.size() && (body[pos] == ' ' || body[pos] == '\t'))
						++pos;
					frame = (Int32)std::strtol(body.c_str() + pos, nullptr, 10);
				}
			}
			BaseDocument* doc = GetActiveDocument();
			if (doc)
			{
				Int32 fps = doc->GetFps();
				BaseTime minT = doc->GetMinTime();
				BaseTime maxT = doc->GetMaxTime();
				Int32 minFrame = minT.GetFrame(fps);
				Int32 maxFrame = maxT.GetFrame(fps);
				if (frame < 0)
					frame = 0;
				Int32 absFrame = minFrame + frame;
				if (absFrame < minFrame)
					absFrame = minFrame;
				if (absFrame > maxFrame)
					absFrame = maxFrame;
				// SetDocumentTime is transport-aware (cooperates with a
				// running RunAnimation) where raw SetTime is not.
				SetDocumentTime(doc, BaseTime(absFrame, fps));
				// EVMSG_TIMECHANGED triggers the viewport + timeline + our
				// own PostTick via CoreMessage, keeping every UI in sync.
				EventAdd();
			}
			return "{\"ok\":true,\"kind\":\"seek-ack\"}";
		}
		if (body.find("\"kind\":\"scrub-begin\"") != std::string::npos)
		{
			// User grabbed the v2 playhead. If transport is actually
			// running, freeze it so the playhead holds wherever this
			// scrub puts it; scrub-end then resumes. We query C4D's REAL
			// transport state (CheckIsRunning) rather than trusting
			// _v2Playing — that flag only flips in toggle-play and goes
			// STALE when native playback stops on its own (range end with
			// loop off, or stopped via C4D's own transport). A stale-true
			// _v2Playing made a plain scrub set _v2ScrubPaused, and
			// scrub-end then auto-started playback the user never asked
			// for. Reconcile the flag to reality here too.
			const Bool reallyRunning = CheckIsRunning(CHECKISRUNNING::ANIMATIONRUNNING);
			_v2Playing = reallyRunning;
			if (reallyRunning && !_v2ScrubPaused)
			{
				_v2ScrubPaused = true;
				BaseDocument* doc = GetActiveDocument();
				if (doc) RunAnimation(doc, true, true);   // stop
			}
			return "{\"ok\":true,\"kind\":\"scrub-begin-ack\"}";
		}
		if (body.find("\"kind\":\"scrub-end\"") != std::string::npos)
		{
			// User released the v2 playhead. Resume native play from the
			// scrubbed-to frame.
			if (_v2ScrubPaused)
			{
				_v2ScrubPaused = false;
				BaseDocument* doc = GetActiveDocument();
				if (doc) RunAnimation(doc, true, false);  // play forward
			}
			return "{\"ok\":true,\"kind\":\"scrub-end-ack\"}";
		}
		if (body.find("\"kind\":\"set-active-camera\"") != std::string::npos)
		{
			// JS routes the playhead-derived active clip's camera here.
			// Body: {"kind":"set-active-camera","objectId":N} where N=0
			// means "release the BaseDraw back to its default" (gap or
			// orphan case, matching Python _route_camera_for_frame).
			Int32 objectId = 0;
			auto pos = body.find("\"objectId\"");
			if (pos != std::string::npos)
			{
				pos = body.find(':', pos);
				if (pos != std::string::npos)
				{
					++pos;
					while (pos < body.size() && (body[pos] == ' ' || body[pos] == '\t'))
						++pos;
					objectId = (Int32)std::strtol(body.c_str() + pos, nullptr, 10);
				}
			}

			BaseDocument* doc = GetActiveDocument();
			BaseDraw* bd = PickTargetBaseDraw(doc);
			Bool changed = false;
			BaseObject* cam = nullptr;
			BaseObject* prevCam = nullptr;
			if (bd && doc)
			{
				if (objectId != 0)
				{
					auto it = _cameraLinks.find(objectId);
					if (it != _cameraLinks.end() && it->second)
						cam = static_cast<BaseObject*>(it->second->GetLink(doc));
				}
				prevCam = bd->GetSceneCamera(doc);
				if (prevCam != cam)
				{
					// Route through SetParameter — the description-framework
					// path the Take System uses internally on take-camera
					// switches. SetSceneCamera writes the link directly via a
					// C-table call, bypassing MSG_DESCRIPTION_POSTSETPARAMETER
					// — the message the BaseDraw's own message handler
					// listens to in order to invalidate its draw-side scene
					// snapshot. Without this invalidation, reverse scrub
					// renders the previous camera even though the link write
					// commits (Object Manager updates correctly).
					AutoAlloc<BaseLink> link;
					if (link)
					{
						link->SetLink(cam);
						GeData data;
						data.SetBaseLink(*link);
						bd->SetParameter(ConstDescIDLevel(BASEDRAW_DATA_CAMERA, 0, 0), data, DESCFLAGS_SET::NONE);
					}
					// Dirty the cameras so the dependency graph rebuilds their
					// world matrices at the current time on the next pass.
					if (prevCam) prevCam->SetDirty(DIRTYFLAGS::MATRIX | DIRTYFLAGS::CACHE);
					if (cam)     cam->SetDirty(DIRTYFLAGS::MATRIX | DIRTYFLAGS::CACHE);
					// Repaint via animation-flagged EventAdd ONLY — the
					// async, sim-safe path C4D's own scrub uses. We do NOT
					// call ExecutePasses(caches=true) + a synchronous
					// DrawViews here: on a scene with a simulation / Alembic
					// cache, fast scrubbing fires set-active-camera rapidly,
					// and a forced cache-rebuilding ExecutePasses re-entered
					// the sim cache build mid-build and CRASHED C4D
					// (reproduced twice; crash stack in c4d_simulation /
					// io_alembic). The reverse-scrub repaint correctness this
					// handler needs comes from the SetParameter
					// (BASEDRAW_DATA_CAMERA) invalidation above, NOT from
					// ExecutePasses — bugs.md proved ExecutePasses "did not
					// provide a behavioral fix" for the reverse-scrub case.
					// Same lesson as the playback fix: never force per-frame
					// ExecutePasses/DrawViews on sim/Alembic scenes; hand the
					// redraw to C4D's own evaluation loop.
					EventAdd(EVENT::ANIMATE);
					changed = true;
				}
			}
			_currentActiveObjectId = objectId;
			return changed
				? "{\"ok\":true,\"kind\":\"set-active-camera-ack\",\"changed\":true}"
				: "{\"ok\":true,\"kind\":\"set-active-camera-ack\",\"changed\":false}";
		}
		if (body.find("\"kind\":\"save-state\"") != std::string::npos)
		{
			// JS sends the full clip-list JSON as a single string. We
			// don't parse it on this side — it's opaque to C++. Stored
			// verbatim on the v2 helper for later retrieval.
			//
			// Body shape:
			//   {"kind":"save-state","json":"<escaped-json-string>","objectIds":[1,2,5]}
			// objectIds is the list of all currently-live objectIds so
			// we can prune stale BaseLinks (cameras that used to be on
			// timeline clips but were deleted from the timeline).
			BaseDocument* doc = GetActiveDocument();
			if (!doc) return "{\"ok\":false,\"error\":\"no doc\"}";

			// Extract the JSON string value. Naive scan: find '"json":'
			// then read the quoted string with backslash-escape handling.
			std::string json;
			{
				auto p = body.find("\"json\"");
				if (p == std::string::npos)
					return "{\"ok\":false,\"error\":\"missing json field\"}";
				p = body.find(':', p);
				if (p == std::string::npos) return "{\"ok\":false,\"error\":\"bad save body\"}";
				p = body.find('"', p);
				if (p == std::string::npos) return "{\"ok\":false,\"error\":\"bad save body\"}";
				++p;
				while (p < body.size() && body[p] != '"')
				{
					if (body[p] == '\\' && p + 1 < body.size())
					{
						char c = body[p + 1];
						if      (c == 'n')  json += '\n';
						else if (c == 't')  json += '\t';
						else if (c == 'r')  json += '\r';
						else if (c == '"')  json += '"';
						else if (c == '\\') json += '\\';
						else if (c == '/')  json += '/';
						else                json += c;
						p += 2;
					}
					else
					{
						json += body[p++];
					}
				}
			}

			BaseObject* helper = GetOrCreateV2Helper(doc);
			if (!helper) return "{\"ok\":false,\"error\":\"helper alloc failed\"}";
			BaseContainer* bc = helper->GetDataInstance();
			if (!bc) return "{\"ok\":false,\"error\":\"helper bc missing\"}";

			// Plan 4.1 — also ensure the hidden Stage helper exists.
			// Idempotent: returns the existing one on subsequent calls.
			// Animation rebuild + render-time toggle land in commits 2+3.
			GetOrCreateStageHelper(doc);

			doc->StartUndo();
			doc->AddUndo(UNDOTYPE::CHANGE_SMALL, helper);
			bc->SetString(BCKEY_CLIPS_JSON, maxon::String(json.c_str()));

			// Keyframes-travel-with-clip: a clip move attaches per-clip
			// frame deltas to this save, and we shift the referenced
			// cameras' keyframes INSIDE this same undo block — so one Ctrl+Z
			// undoes both the clip-position change and the keyframe shift.
			// JS fires the move-save immediately (not debounced) so there's
			// no visible lag between the clip jumping and the keys following.
			ApplyKeyframeShiftsFromBody(doc, body);

			// Alt-retime: an edge drag with Alt held rescales the referenced
			// camera's keyframes around the non-moving edge so the motion
			// fills the clip's new duration. Same in-block undo + shared-
			// camera guard as the shift; sibling array in the save payload.
			ApplyKeyframeRetimesFromBody(doc, body);

			// Free bytes for media orphaned by this edit (e.g. an audio
			// clip was deleted). Done INSIDE this undo block so the clip-
			// JSON change and the byte removal are one atomic undo step —
			// Ctrl+Z restores the clip AND its audio together. The
			// AddUndo above already snapshotted the whole helper BC
			// (bytes included), so this costs no extra undo memory.
			RemoveOrphanedAudioBytes(bc, body);
			// Bump a monotonic version counter so EVMSG_CHANGE
			// handlers (including ours) can distinguish "the helper
			// changed because of something the user did via Ctrl+Z"
			// from "we just wrote it ourselves".
			const Int32 newVersion = bc->GetInt32(BCKEY_VERSION) + 1;
			bc->SetInt32(BCKEY_VERSION, newVersion);
			_lastSeenVersion = newVersion;

			// Persist BaseLinks for every currently-live objectId.
			// Removed-from-timeline objectIds (in old _cameraLinks but
			// not in this save's objectIds list) get their BaseContainer
			// entries cleared so the helper doesn't accumulate cruft.
			// Parse the objectIds array.
			std::set<Int32> liveIds;
			{
				auto p = body.find("\"objectIds\"");
				if (p != std::string::npos)
				{
					p = body.find('[', p);
					if (p != std::string::npos)
					{
						++p;
						while (p < body.size() && body[p] != ']')
						{
							while (p < body.size() && (body[p] == ' ' || body[p] == ',' || body[p] == '\t')) ++p;
							if (p >= body.size() || body[p] == ']') break;
							char* endp = nullptr;
							long v = std::strtol(body.c_str() + p, &endp, 10);
							if (endp && endp != body.c_str() + p)
							{
								if (v != 0) liveIds.insert((Int32)v);
								p = endp - body.c_str();
							}
							else
							{
								++p;
							}
						}
					}
				}
			}
			// Write/refresh BaseLinks for every live id we have a
			// _cameraLinks entry for. BaseContainer::SetLink stores a
			// persistent link to the BaseList2D that survives doc save
			// + reload, and follows the object through OM renames.
			for (Int32 id : liveIds)
			{
				auto it = _cameraLinks.find(id);
				if (it == _cameraLinks.end() || !it->second) continue;
				BaseObject* op = static_cast<BaseObject*>(it->second->GetLink(doc));
				if (!op) continue;
				bc->SetLink(BCKEY_CAM_LINK_BASE + id, op);
			}
			doc->EndUndo();
			EventAdd();
			return "{\"ok\":true,\"kind\":\"save-state-ack\"}";
		}
		if (body.find("\"kind\":\"load-state\"") != std::string::npos)
		{
			// JS asks for the persisted blob. Returns the JSON string
			// (escaped for re-embedding) and rebuilds the in-memory
			// _cameraLinks map from the helper's stored BaseLinks so
			// camera routing works on the very first frame after
			// reload — no need to re-drop the cameras.
			BaseDocument* doc = GetActiveDocument();
			if (!doc) return "{\"ok\":false,\"error\":\"no doc\"}";
			BaseObject* helper = FindV2Helper(doc);
			if (!helper) return "{\"ok\":true,\"kind\":\"load-state-ack\",\"json\":\"\"}";
			BaseContainer* bc = helper->GetDataInstance();
			if (!bc) return "{\"ok\":true,\"kind\":\"load-state-ack\",\"json\":\"\"}";

			String raw = bc->GetString(BCKEY_CLIPS_JSON);
			std::string rawUtf8;
			{
				// cinema::String adds GetCStringCopy on top of
				// maxon::String. Returns a heap-allocated UTF-8 buffer
				// that we must free via DeleteMem.
				Char* cstr = raw.GetCStringCopy();
				if (cstr)
				{
					rawUtf8 = cstr;
					DeleteMem(cstr);
				}
			}

			// Rebuild _cameraLinks from the helper's stored BaseLinks.
			// BaseContainer doesn't expose an enumeration API for keys,
			// so we scan a known range (objectId is monotonic from 1).
			_cameraLinks.clear();
			Int32 maxObjectIdSeen = 0;
			const Int32 SCAN_MAX = 4096;
			for (Int32 id = 1; id <= SCAN_MAX; ++id)
			{
				BaseList2D* linked = bc->GetLink(BCKEY_CAM_LINK_BASE + id, doc);
				if (!linked) continue;
				if (!linked->IsInstanceOf(Obase)) continue;
				AutoAlloc<BaseLink> newLink;
				if (!newLink) continue;
				newLink->SetLink(linked);
				_cameraLinks.emplace(id, std::move(newLink));
				if (id > maxObjectIdSeen) maxObjectIdSeen = id;
			}
			if (maxObjectIdSeen + 1 > _nextObjectId)
				_nextObjectId = maxObjectIdSeen + 1;
			// Seed _lastSeenVersion to the helper's current version so
			// the immediate post-load EVMSG_CHANGE (if any) doesn't
			// trigger a spurious state-changed notification.
			_lastSeenVersion = bc->GetInt32(BCKEY_VERSION);
			// Push a fresh cameras snapshot now that _cameraLinks is
			// rebuilt for the loaded doc.
			PostCameras();

			// Escape the JSON string for embedding in our response.
			std::string esc;
			esc.reserve(rawUtf8.size() + 8);
			for (char c : rawUtf8)
			{
				if      (c == '\\') esc += "\\\\";
				else if (c == '"')  esc += "\\\"";
				else if (c == '\n') esc += "\\n";
				else if (c == '\r') esc += "\\r";
				else if (c == '\t') esc += "\\t";
				else                esc += c;
			}
			std::string resp = "{\"ok\":true,\"kind\":\"load-state-ack\",\"json\":\"";
			resp += esc;
			resp += "\"}";
			return resp;
		}
		if (body.find("\"kind\":\"toggle-play\"") != std::string::npos)
		{
			// Delegates to C4D's native play transport (RunAnimation);
			// see the long note in Timer(). We point C4D's loop range at
			// the v2 play range so native play wraps/stops there, and the
			// EVMSG_TIMECHANGED tick keeps the v2 playhead synced.
			BaseDocument* doc = GetActiveDocument();
			if (!doc) return "{\"ok\":false,\"error\":\"no doc\"}";
			if (_v2Playing)
			{
				_v2Playing = false;
				RunAnimation(doc, true, true);   // stop
			}
			else
			{
				_v2Playing = true;
				Int32 fps = doc->GetFps();
				if (fps <= 0) fps = 30;
				BaseTime minT = doc->GetMinTime();
				Int32 minFrame = minT.GetFrame(fps);
				Int32 curFrame = doc->GetTime().GetFrame(fps) - minFrame;
				// If the playhead is outside the play range, snap to
				// rangeIn before starting.
				if (curFrame < _v2RangeIn || curFrame >= _v2RangeOut)
				{
					curFrame = _v2RangeIn;
					SetDocumentTime(doc, BaseTime(minFrame + curFrame, fps));
				}
				ApplyV2RangeToDocLoop(doc);
				RunAnimation(doc, true, false);  // play forward
			}
			PostTick();
			return "{\"ok\":true,\"kind\":\"toggle-play-ack\"}";
		}
		if (body.find("\"kind\":\"set-play-range\"") != std::string::npos)
		{
			// Cache the v2 play range and push it to C4D's loop range so
			// native play (which we delegate to) wraps/stops there. If
			// playback is live, update the loop range immediately.
			Int32 inFrame  = ParseIntField(body, "inFrame");
			Int32 outFrame = ParseIntField(body, "outFrame");
			if (inFrame  < 0) inFrame  = 0;
			if (outFrame <= inFrame) outFrame = inFrame + 1;
			_v2RangeIn  = inFrame;
			_v2RangeOut = outFrame;
			// Push to C4D's loop range immediately (not just when
			// playing) so the I/O shortcuts update C4D's timeline preview
			// bracket right away, before the user hits play. Also adds the
			// EventAdd so the C4D timeline repaints the new bracket.
			BaseDocument* doc = GetActiveDocument();
			if (doc)
			{
				ApplyV2RangeToDocLoop(doc);
				EventAdd();
			}
			return "{\"ok\":true,\"kind\":\"set-play-range-ack\"}";
		}
		if (body.find("\"kind\":\"set-doc-frames\"") != std::string::npos) return HandleSetDocFrames(body);
		if (body.find("\"kind\":\"set-loop\"") != std::string::npos) return HandleSetLoop(body);
		if (body.find("\"kind\":\"warp-cursor\"") != std::string::npos) return HandleWarpCursor(body);
		if (body.find("\"kind\":\"get-camera-types\"") != std::string::npos) return HandleGetCameraTypes();
		if (body.find("\"kind\":\"create-camera\"") != std::string::npos) return HandleCreateCamera(body);
		if (body.find("\"kind\":\"select-in-om\"") != std::string::npos) return HandleSelectInOm(body);
		if (body.find("\"kind\":\"set-stage-cameras\"") != std::string::npos) return HandleSetStageCameras(body);
		if (body.find("\"kind\":\"audio-add\"") != std::string::npos)
		{
			// JS pushes the original audio bytes (base64) once at drop
			// time. Stored in the helper's BaseContainer keyed by
			// BCKEY_AUDIO_BASE + clipId. The clip-list JSON references
			// audio by clipId — bytes never re-ship on subsequent clip
			// moves / trims / saves.
			Int32 clipId = ParseIntField(body, "clipId");
			if (clipId <= 0)
				return "{\"ok\":false,\"error\":\"bad clipId\"}";
			std::string bytes = ParseStringField(body, "bytes");
			BaseDocument* doc = GetActiveDocument();
			if (!doc) return "{\"ok\":false,\"error\":\"no doc\"}";
			BaseObject* helper = GetOrCreateV2Helper(doc);
			if (!helper) return "{\"ok\":false,\"error\":\"helper alloc failed\"}";
			BaseContainer* bc = helper->GetDataInstance();
			if (!bc) return "{\"ok\":false,\"error\":\"helper bc missing\"}";

			// Audio bytes are media, not undoable user state. Don't wrap
			// this write in StartUndo/AddUndo — AddUndo(CHANGE_SMALL,
			// helper) snapshots the ENTIRE helper BC, including any
			// already-stored audio bytes. Over a few add/remove cycles
			// the undo stack accumulates MBs of stale audio that ride
			// along in the saved .c4d (see .agent/bugs.md "file size
			// bloat"). The clip metadata IS still undoable via save-
			// state's own AddUndo on the clip JSON, which is small.
			bc->SetString(BCKEY_AUDIO_BASE + clipId, maxon::String(bytes.c_str()));
			const Int32 newVersion = bc->GetInt32(BCKEY_VERSION) + 1;
			bc->SetInt32(BCKEY_VERSION, newVersion);
			_lastSeenVersion = newVersion;
			EventAdd();
			return "{\"ok\":true,\"kind\":\"audio-add-ack\"}";
		}
		if (body.find("\"kind\":\"audio-fetch\"") != std::string::npos)
		{
			// JS asks for the persisted audio bytes for one clipId.
			// Called on doc load for each audio clip we don't already
			// have in JS memory. Returns base64 string (possibly empty
			// if the clip predates audio import or has no bytes stored).
			Int32 clipId = ParseIntField(body, "clipId");
			if (clipId <= 0)
				return "{\"ok\":false,\"error\":\"bad clipId\"}";
			BaseDocument* doc = GetActiveDocument();
			if (!doc) return "{\"ok\":false,\"error\":\"no doc\"}";
			BaseObject* helper = FindV2Helper(doc);
			if (!helper)
				return "{\"ok\":true,\"kind\":\"audio-fetch-ack\",\"bytes\":\"\"}";
			BaseContainer* bc = helper->GetDataInstance();
			if (!bc)
				return "{\"ok\":true,\"kind\":\"audio-fetch-ack\",\"bytes\":\"\"}";

			String raw = bc->GetString(BCKEY_AUDIO_BASE + clipId);
			std::string rawUtf8;
			Char* cstr = raw.GetCStringCopy();
			if (cstr)
			{
				rawUtf8 = cstr;
				DeleteMem(cstr);
			}
			// The stored value is itself a base64 string (no JSON-
			// special characters), so we can embed it verbatim. The
			// only escape needed is the JSON-string termination.
			std::string resp = "{\"ok\":true,\"kind\":\"audio-fetch-ack\",\"bytes\":\"";
			resp += rawUtf8;
			resp += "\"}";
			return resp;
		}
		if (body.find("\"kind\":\"audio-remove\"") != std::string::npos)
		{
			// JS notifies that a clip with audio was deleted. Free the
			// helper's storage so deleted audio doesn't ride along in
			// the doc.
			Int32 clipId = ParseIntField(body, "clipId");
			if (clipId <= 0)
				return "{\"ok\":false,\"error\":\"bad clipId\"}";
			BaseDocument* doc = GetActiveDocument();
			if (!doc) return "{\"ok\":false,\"error\":\"no doc\"}";
			BaseObject* helper = FindV2Helper(doc);
			if (!helper)
				return "{\"ok\":true,\"kind\":\"audio-remove-ack\"}";
			BaseContainer* bc = helper->GetDataInstance();
			if (!bc)
				return "{\"ok\":true,\"kind\":\"audio-remove-ack\"}";

			// No undo wrapping (see audio-add comment): the snapshot would
			// otherwise re-capture the bytes we're about to delete and
			// strand them in the undo stack permanently.
			bc->RemoveData(BCKEY_AUDIO_BASE + clipId);
			const Int32 newVersion = bc->GetInt32(BCKEY_VERSION) + 1;
			bc->SetInt32(BCKEY_VERSION, newVersion);
			_lastSeenVersion = newVersion;
			EventAdd();
			return "{\"ok\":true,\"kind\":\"audio-remove-ack\"}";
		}
		if (body.find("\"kind\":\"open-manual\"") != std::string::npos) return HandleOpenManual();
		if (body.find("\"kind\":\"helper-stats\"") != std::string::npos) return HandleHelperStats();
		if (body.find("\"kind\":\"helper-compact\"") != std::string::npos) return HandleHelperCompact();
		if (body.find("\"kind\":\"add-to-queue\"") != std::string::npos) return HandleAddToQueue(body);
		if (body.find("\"kind\":\"sync-render-settings\"") != std::string::npos) return HandleSyncRenderSettings(body);
		if (body.find("\"kind\":\"undo\"") != std::string::npos)
		{
			// WebView2 swallows Ctrl+Z before C4D's menu sees it, so JS
			// forwards the keystroke here. We invoke C4D's native undo
			// (DoUndo). The undo will roll back the helper's
			// BaseContainer, EVMSG_CHANGE will fire, our handler will
			// detect the version mismatch and tell JS to reload.
			BaseDocument* doc = GetActiveDocument();
			if (doc)
			{
				doc->DoUndo();
				EventAdd();
			}
			return "{\"ok\":true,\"kind\":\"undo-ack\"}";
		}
		if (body.find("\"kind\":\"redo\"") != std::string::npos)
		{
			BaseDocument* doc = GetActiveDocument();
			if (doc)
			{
				doc->DoRedo();
				EventAdd();
			}
			return "{\"ok\":true,\"kind\":\"redo-ack\"}";
		}
		GePrint("[Shotblocks/v2] unhandled cmd: "_s + maxon::String(body.c_str()));
		return "{\"ok\":false,\"error\":\"unknown command\"}";
	}

	// Pick the BaseDraw the camera router writes to. First call pins
	// the choice — preferring a perspective view — so 4-up layouts'
	// Top / Front / Side viewports don't get hijacked when the user
	// focuses one. Subsequent calls reuse the pin unless the pinned
	// BaseDraw was destroyed. Matches Python _pick_target_basedraw
	// (sb_canvas_playback.py:192).
	BaseDraw* PickTargetBaseDraw(BaseDocument* doc)
	{
		if (!doc) return nullptr;
		// Verify the pin is still alive in this document by walking
		// the BaseDraw list.
		if (_pinnedBaseDraw)
		{
			for (Int32 i = 0; ; ++i)
			{
				BaseDraw* bd = doc->GetBaseDraw(i);
				if (!bd) break;
				if (bd == _pinnedBaseDraw)
					return _pinnedBaseDraw;
			}
			_pinnedBaseDraw = nullptr;  // stale
		}
		// First call (or stale pin): prefer the first perspective BD.
		for (Int32 i = 0; ; ++i)
		{
			BaseDraw* bd = doc->GetBaseDraw(i);
			if (!bd) break;
			GeData proj;
			bd->GetParameter(ConstDescID(DescLevel(BASEDRAW_DATA_PROJECTION)), proj, DESCFLAGS_GET::NONE);
			if (proj.GetInt32() == BASEDRAW_PROJECTION_PERSPECTIVE)
			{
				_pinnedBaseDraw = bd;
				return bd;
			}
		}
		// No perspective view — fall back to active BD.
		_pinnedBaseDraw = doc->GetActiveBaseDraw();
		return _pinnedBaseDraw;
	}

	// Point C4D's loop range at the v2 play range so native play
	// (RunAnimation) wraps/stops there. C4D's loop *mode* button isn't
	// SDK-settable, but the loop min/max times are. Range is stored as
	// frames relative to doc min; convert to absolute BaseTime.
	void ApplyV2RangeToDocLoop(BaseDocument* doc)
	{
		if (!doc)
			return;
		Int32 fps = doc->GetFps();
		if (fps <= 0)
			fps = 30;
		Int32 minFrame = doc->GetMinTime().GetFrame(fps);
		Int32 maxFrame = doc->GetMaxTime().GetFrame(fps);
		Int32 inAbs  = minFrame + _v2RangeIn;
		Int32 outAbs = minFrame + _v2RangeOut - 1;   // inclusive last frame
		// Clamp to the document's own range so we never set a loop
		// outside [min, max] (C4D ignores / misbehaves otherwise).
		if (inAbs  < minFrame) inAbs  = minFrame;
		if (outAbs > maxFrame) outAbs = maxFrame;
		if (outAbs < inAbs)    outAbs = inAbs;
		doc->SetLoopMinTime(BaseTime(inAbs,  fps));
		doc->SetLoopMaxTime(BaseTime(outAbs, fps));
	}

	// ------- C++ -> JS state push -------

	void PostTick()
	{
		if (!_htmlView || !_navigated)
			return;
		BaseDocument* doc = GetActiveDocument();
		if (!doc)
			return;
		Int32 fps = doc->GetFps();
		Int32 frame = doc->GetTime().GetFrame(fps);
		Float nowMs = GeGetMilliSeconds();
		// `playing` reflects EITHER v2-owned playback (spacebar) OR any
		// C4D-native timeline activity (play button OR scrubbing — both
		// fire EVMSG_TIMECHANGED, indistinguishable from here). The
		// visual playhead syncs to `playing` either way.
		// `pluginPlaying` is the NARROW signal: true only for v2-owned
		// playback. The audio layer uses it to honor the "audio follows
		// C4D timeline" setting — when that's off, audio responds to
		// pluginPlaying only, so C4D-native scrub/play makes no sound.
		bool externalPlaying = (nowMs - _lastTimeChangedTickMs) < 200.0;
		bool playing = _v2Playing || externalPlaying;
		bool pluginPlaying = _v2Playing;
		// A scrub-hold during playback freezes transport — report
		// not-playing so the timeline + audio stop at the held frame.
		// (externalPlaying would otherwise stay true: each scrub seek
		// fires EVMSG_TIMECHANGED.)
		if (_v2ScrubPaused)
		{
			playing = false;
			pluginPlaying = false;
		}

		char buf[256];
		_snprintf_s(buf, sizeof(buf), _TRUNCATE,
			"{\"kind\":\"tick\",\"frame\":%d,\"fps\":%d,\"playing\":%s,\"pluginPlaying\":%s}",
			(int)frame, (int)fps, playing ? "true" : "false",
			pluginPlaying ? "true" : "false");
		_htmlView->PostWebMessage(maxon::String(buf));
	}

	void PostDocInfo()
	{
		if (!_htmlView)
			return;
		BaseDocument* doc = GetActiveDocument();
		if (!doc)
			return;
		Int32 fps = doc->GetFps();
		BaseTime minT = doc->GetMinTime();
		BaseTime maxT = doc->GetMaxTime();
		Int32 docFrames = (Int32)(maxT.GetFrame(fps) - minT.GetFrame(fps));
		// playRange fields broadcast the v2-owned cache, not C4D's
		// native loop bounds (which v2 deliberately doesn't touch so
		// C4D's own play button stays independent). On first
		// connection, default to [0, docFrames] so JS sees the full
		// doc as "no play range defined."
		if (_v2RangeOut > docFrames || _v2RangeOut == (1 << 30))
			_v2RangeOut = docFrames;
		char buf[256];
		_snprintf_s(buf, sizeof(buf), _TRUNCATE,
			"{\"kind\":\"doc-info\",\"fps\":%d,\"docFrames\":%d,\"playRangeIn\":%d,\"playRangeOut\":%d}",
			(int)fps, (int)docFrames, (int)_v2RangeIn, (int)_v2RangeOut);
		_htmlView->PostWebMessage(maxon::String(buf));
	}

	// Handle JS's `add-to-queue` command. Body shape:
	//   {"kind":"add-to-queue","mode":"whole-sequence"|"individual-shots"}
	// For whole-sequence we append the saved .c4d to C4D's Render
	// Queue once — the user's existing render settings is the source
	// Handler for `set-cursor-mode`. Extracted from Dispatch to keep
	// it under the sourceprocessor's 600-line function cap. Parses
	// the mode from the body, stores into _cursorMode (read by the
	// WM_SETCURSOR subclass proc on every move), applies immediately
	// and drives the fast Win32 timer.
	void HandleSetCursorMode(const std::string& body)
	{
		int m = CURSOR_DEFAULT;
		if (body.find("\"mode\":\"slip\"") != std::string::npos)
			m = CURSOR_SLIP;
		else if (body.find("\"mode\":\"razor\"") != std::string::npos)
			m = CURSOR_RAZOR;
		// No "select" case — the Select tool uses the OS default
		// cursor (removed to kill the playback cursor flicker).
		else if (body.find("\"mode\":\"av-split\"") != std::string::npos)
			m = CURSOR_AV_SPLIT;
		else if (body.find("\"mode\":\"roll\"") != std::string::npos)
			m = CURSOR_ROLL;
		else if (body.find("\"mode\":\"play-range\"") != std::string::npos)
			m = CURSOR_PLAY_RANGE;
		else if (body.find("\"mode\":\"pen\"") != std::string::npos)
			m = CURSOR_PEN;
		else if (body.find("\"mode\":\"hand-grab\"") != std::string::npos)
			m = CURSOR_HAND_GRAB;
		else if (body.find("\"mode\":\"hand\"") != std::string::npos)
			m = CURSOR_HAND;
		else if (body.find("\"mode\":\"zoom\"") != std::string::npos)
			m = CURSOR_ZOOM;
		else if (body.find("\"mode\":\"retime\"") != std::string::npos)
			m = CURSOR_RETIME;
		_cursorMode.store(m);
		char b[64];
		_snprintf_s(b, sizeof(b), _TRUNCATE, "[Shotblocks/v2] set-cursor-mode -> %d", m);
		GePrint(maxon::String(b));
		// Apply immediately (WM_SETCURSOR only fires on movement),
		// and drive a fast Win32 timer that keeps re-asserting the
		// cursor so WebView2's own resets never show. Kill the
		// timer when we return to no-override.
		if (_cursorSubclassed)
		{
			if (m != CURSOR_DEFAULT)
			{
				HCURSOR c = CurrentForcedCursor();
				if (c) SetCursor(c);
				// ::SetTimer — the Win32 one. Unqualified SetTimer
				// resolves to GeDialog::SetTimer (different sig).
				::SetTimer(_cursorSubclassed, kCursorTimerId, 16, nullptr);
			}
			else
			{
				::KillTimer(_cursorSubclassed, kCursorTimerId);
			}
		}
	}

	// Handler for `set-doc-frames` — grow (or set) the document length.
	// JS sends this when Add Camera can't fit a full-length camera on the
	// targeted track; we extend C4D's max time so the new camera gets its
	// full duration at the tail instead of a 1-frame sliver. Mirrors the
	// set-play-range pattern. Extracted to keep Dispatch under the
	// sourceprocessor's 600-line function cap.
	//
	// Intentionally NOT undoable: this is a plain SetMaxTime with no
	// AddUndo, so undoing the Add Camera leaves the longer sequence (the
	// user shortens it manually if they want). Min time is preserved, not
	// assumed to be 0, to match PostDocInfo's maxFrame - minFrame.
	std::string HandleSetDocFrames(const std::string& body)
	{
		Int32 frames = ParseIntField(body, "frames");
		if (frames < 1) frames = 1;
		BaseDocument* doc = GetActiveDocument();
		if (doc)
		{
			Int32 fps = doc->GetFps();
			Int32 minFrame = doc->GetMinTime().GetFrame(fps);
			doc->SetMaxTime(BaseTime(minFrame + frames, fps));
			EventAdd();
			PostDocInfo();
		}
		return "{\"ok\":true,\"kind\":\"set-doc-frames-ack\"}";
	}

	// Handler for `set-loop` (ShotBlocks -> C4D loop sync). Caches v2's
	// loop flag AND mirrors it onto C4D's native loop buttons so the two
	// stay in sync. C4D's loop is two mutually-exclusive TOGGLE commands
	// (probed this session):
	//   12426 = "loop with 1" button = loop OFF (play once)
	//   12427 = plain loop button    = loop ON  (continuous)
	// CallCommand TOGGLES, so guard with IsCommandChecked to avoid
	// flipping an already-correct state into the wrong one. Extracted
	// from Dispatch to stay under the sourceprocessor's 600-line cap.
	std::string HandleSetLoop(const std::string& body)
	{
		const Bool enabled = body.find("\"enabled\":true") != std::string::npos;
		_v2LoopEnabled = enabled;
		const Int32 LOOP_ON = 12427, LOOP_OFF = 12426;
		if (enabled  && !IsCommandChecked(LOOP_ON))  CallCommand(LOOP_ON);
		if (!enabled && !IsCommandChecked(LOOP_OFF)) CallCommand(LOOP_OFF);
		// Record the state we just set so the Timer poll doesn't echo
		// this same change straight back to JS as a redundant message.
		_lastLoopChecked = enabled ? 1 : 0;
		return "{\"ok\":true,\"kind\":\"set-loop-ack\"}";
	}

	// of truth. individual-shots will land in Commit 10. Factored
	// into its own method to keep Dispatch under the sourceprocessor's
	// 600-line function cap.
	// Free audio bytes for every mediaId in the body's "removeAudioMedia"
	// array. Called from inside save-state's StartUndo/EndUndo so a clip
	// delete + its byte removal are one atomic undo. Extracted to keep
	// Dispatch under Maxon's 600-line source-processor cap.
	void RemoveOrphanedAudioBytes(BaseContainer* bc, const std::string& body)
	{
		if (!bc) return;
		auto rp = body.find("\"removeAudioMedia\"");
		if (rp == std::string::npos) return;
		rp = body.find('[', rp);
		if (rp == std::string::npos) return;
		++rp;
		while (rp < body.size() && body[rp] != ']')
		{
			while (rp < body.size() && (body[rp] == ' ' || body[rp] == ',' || body[rp] == '\t')) ++rp;
			if (rp >= body.size() || body[rp] == ']') break;
			char* endp = nullptr;
			long mediaId = std::strtol(body.c_str() + rp, &endp, 10);
			if (endp && endp != body.c_str() + rp)
			{
				if (mediaId > 0)
					bc->RemoveData(BCKEY_AUDIO_BASE + (Int32)mediaId);
				rp = endp - body.c_str();
			}
			else
			{
				++rp;
			}
		}
	}

	// Teleport the OS cursor to (x,y) in SCREEN pixels. Used by the
	// timecode scrub to wrap the cursor edge-to-edge so the drag is
	// infinite (JS can't move the cursor itself). The resulting synthetic
	// movementX is suppressed JS-side. Extracted to keep Dispatch under
	// Maxon's 600-line source-processor cap.
	std::string HandleWarpCursor(const std::string& body)
	{
		Int32 x = ParseIntField(body, "x");
		Int32 y = ParseIntField(body, "y");
		SetCursorPos((int)x, (int)y);
		return "{\"ok\":true,\"kind\":\"warp-cursor-ack\"}";
	}

	// Open the bundled user manual in the OS default browser. The manual
	// is static HTML shipped inside the plugin folder at docs/index.html
	// (deploy.ps1 / package.ps1 copy it next to the .xdl64). We resolve
	// the plugin folder from this DLL's own path — the same trick
	// EnsureNavigated uses for web/index.html — so it works from whatever
	// plugins directory the user installed into, not a dev-hardcoded path.
	// ShellExecuteW("open", <local html path>, ...) launches the file in
	// the registered default browser. Extracted to keep Dispatch under
	// Maxon's 600-line source-processor cap.
	std::string HandleOpenManual()
	{
		HMODULE hMod = nullptr;
		GetModuleHandleExW(
			GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
			GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
			(LPCWSTR)&ShotblocksDialog::DispatchHttpStatic,
			&hMod);
		wchar_t dll[MAX_PATH] = {0};
		GetModuleFileNameW(hMod, dll, MAX_PATH);
		wchar_t* lastSlash = wcsrchr(dll, L'\\');
		if (lastSlash)
			*(lastSlash + 1) = 0;
		wchar_t path[MAX_PATH + 64];
		swprintf_s(path, MAX_PATH + 64, L"%sdocs\\index.html", dll);

		// Pass the plain filesystem path (not a file:// URL) so the shell
		// resolves the default browser via the .html association.
		HINSTANCE rc = ShellExecuteW(nullptr, L"open", path, nullptr, nullptr, SW_SHOWNORMAL);
		// ShellExecuteW returns a value > 32 on success.
		if ((INT_PTR)rc <= 32)
		{
			GePrint("[Shotblocks/v2] open-manual failed (ShellExecute rc="_s
				+ maxon::String::IntToString((Int32)(INT_PTR)rc) + ") for "_s
				+ maxon::String(path));
			return "{\"ok\":false,\"kind\":\"open-manual-ack\",\"error\":\"shellexecute failed\"}";
		}
		return "{\"ok\":true,\"kind\":\"open-manual-ack\"}";
	}

	// Diag: walk the helper BaseContainer and print per-range byte totals
	// to the C4D Console. Used to triage .c4d file-size bloat
	// (.agent/bugs.md "file size bloat"). One-shot — extracted to a
	// helper to keep Dispatch under Maxon's 600-line source-processor cap.
	std::string HandleHelperStats()
	{
		BaseDocument* doc = GetActiveDocument();
		BaseObject* helper = doc ? FindV2Helper(doc) : nullptr;
		if (!helper) return "{\"ok\":false,\"error\":\"no helper\"}";
		BaseContainer* bc = helper->GetDataInstance();
		if (!bc) return "{\"ok\":false,\"error\":\"no helper bc\"}";
		Int64 metaBytes = 0, camLinkBytes = 0, audioBytes = 0, otherBytes = 0;
		Int32 metaCount = 0, camCount = 0, audioCount = 0, otherCount = 0;
		Int64 totalBytes = 0;
		Int32 maxAudioKey = 0, maxAudioLen = 0;
		for (Int32 i = 0; ; ++i)
		{
			Int32 id = bc->GetIndexId(i);
			if (id == NOTOK) break;
			maxon::String s = bc->GetString(id);
			Int64 sLen = (Int64)s.GetLength();
			Int64 entryBytes = sLen > 0 ? sLen : 8;
			totalBytes += entryBytes;
			if (id == BCKEY_HELPER_MARKER || id == BCKEY_CLIPS_JSON || id == BCKEY_VERSION)
			{
				metaBytes += entryBytes; ++metaCount;
			}
			else if (id >= BCKEY_CAM_LINK_BASE && id < BCKEY_AUDIO_BASE)
			{
				camLinkBytes += entryBytes; ++camCount;
			}
			else if (id >= BCKEY_AUDIO_BASE)
			{
				audioBytes += entryBytes; ++audioCount;
				if ((Int32)sLen > maxAudioLen) { maxAudioLen = (Int32)sLen; maxAudioKey = id; }
			}
			else
			{
				otherBytes += entryBytes; ++otherCount;
			}
		}
		Char buf[512];
		std::snprintf(buf, sizeof(buf),
			"[Shotblocks/v2] helper-stats total=%lld  meta=%lld(%d)  camLinks=%lld(%d)  audio=%lld(%d)  other=%lld(%d)  largestAudioMediaId=%d size=%d",
			(long long)totalBytes,
			(long long)metaBytes, (int)metaCount,
			(long long)camLinkBytes, (int)camCount,
			(long long)audioBytes, (int)audioCount,
			(long long)otherBytes, (int)otherCount,
			(int)(maxAudioKey - BCKEY_AUDIO_BASE), (int)maxAudioLen);
		GePrint(maxon::String(buf));
		return "{\"ok\":true,\"kind\":\"helper-stats-ack\"}";
	}

	// Flush the document's entire undo stack. Used to compact .c4d files
	// that grew huge from accumulated undo snapshots of the helper BC
	// (audio bytes were undo-wrapped pre-2026-05-26 fix). User runs this
	// once on a bloated scene, then Ctrl+S — the saved file should be
	// dramatically smaller. NOT something users should run accidentally
	// (it wipes all undo history), hence keep it CDP-only.
	std::string HandleHelperCompact()
	{
		BaseDocument* doc = GetActiveDocument();
		if (!doc) return "{\"ok\":false,\"error\":\"no doc\"}";
		doc->FlushUndoBuffer();
		GePrint("[Shotblocks/v2] helper-compact: undo buffer flushed. Ctrl+S to write the smaller file."_s);
		return "{\"ok\":true,\"kind\":\"helper-compact-ack\"}";
	}

	std::string HandleAddToQueue(const std::string& body)
	{
		BaseDocument* doc = GetActiveDocument();
		if (!doc)
			return "{\"ok\":false,\"error\":\"no doc\",\"status\":\"No active document\"}";

		// Doc must be saved to disk before AddFile — the queue
		// references a file path, not the live in-memory doc. C4D
		// distinguishes "never saved" from "saved" by GetDocumentPath
		// being empty (the folder hasn't been set). The document name
		// alone isn't reliable — C4D fills it with placeholders like
		// "Untitled 2" for new docs.
		const String docFolder = doc->GetDocumentPath().GetString();
		const String docName = doc->GetDocumentName().GetString();
		if (docFolder.GetLength() == 0 || docName.GetLength() == 0)
			return "{\"ok\":false,\"error\":\"unsaved\",\"status\":\"Save scene first\"}";
		Filename docPath = doc->GetDocumentPath() + doc->GetDocumentName();

		std::string mode = ParseStringField(body, "mode");
		if (mode == "individual-shots")
			return HandleAddToQueueIndividual(doc, docPath, body);

		// Whole-sequence path.
		BatchRender* br = GetBatchRender();
		if (!br)
			return "{\"ok\":false,\"error\":\"no batchrender\",\"status\":\"Render Queue unavailable\"}";

		if (!br->AddFile(docPath, 1 << 30))
			return "{\"ok\":false,\"error\":\"add failed\",\"status\":\"Queue add failed\"}";

		br->Open();
		return "{\"ok\":true,\"kind\":\"add-to-queue-ack\",\"status\":\"Added scene to Render Queue\"}";
	}

	// Settings → Defaults → Default camera type. Walks the known camera
	// plugin IDs (kCameraCandidates) and returns the subset that actually
	// resolves in this C4D session — RS Camera only shows when Redshift
	// is loaded. See plan-4 R1.
	//
	// Label policy: use the candidate's hardcoded defaultLabel rather
	// than BasePlugin::GetName(). C4D's GetName returns "Camera" for
	// Ocamera which is ambiguous in a settings dropdown alongside other
	// camera types — "Standard Camera" reads more clearly. The cost is
	// English-only dropdown labels (no localization), acceptable for
	// plugin-config UI.
	std::string HandleGetCameraTypes()
	{
		std::string out = "{\"ok\":true,\"kind\":\"camera-types-ack\",\"types\":[";
		bool first = true;
		for (Int i = 0; i < kCameraCandidateCount; ++i)
		{
			const CameraTypeCandidate& c = kCameraCandidates[i];
			if (!FindPlugin(c.id, PLUGINTYPE::OBJECT)) continue;
			if (!first) out += ',';
			first = false;
			out += "{\"id\":";
			out += std::to_string(c.id);
			out += ",\"label\":\"";
			for (const char* p = c.defaultLabel; *p; ++p)
			{
				if (*p == '"' || *p == '\\') out += '\\';
				out += *p;
			}
			out += "\"}";
		}
		out += "]}";
		return out;
	}

	// Plan 4 commit 2 — Add Camera button. Allocates a new camera of
	// the user's preferred type (per Settings → Defaults), copies the
	// editor camera's pose + lens params so the new view looks identical
	// to what the user is looking at, inserts at the OM root top, and
	// selects it in the OM. Atomic undo wraps insertion + activation
	// (per R3 / microsdk example). Viewport routing happens after this
	// returns — JS adds a clip at the playhead, and the existing
	// playhead-driven router fires set-active-camera which switches the
	// viewport via the SetParameter recipe (memory
	// c4d-setscenecamera-bypasses-cache-invalidation).
	std::string HandleCreateCamera(const std::string& body)
	{
		BaseDocument* doc = GetActiveDocument();
		if (!doc) return "{\"ok\":false,\"error\":\"no doc\"}";

		// Parse typeId from the request body. JS sends the user's
		// defaultCameraType setting (plugin ID). Validate it actually
		// resolves before alloc — if Redshift was unloaded between
		// Settings setting it and the click, fall back to Standard.
		Int32 typeId = ParseIntField(body, "typeId");
		if (typeId <= 0 || !FindPlugin(typeId, PLUGINTYPE::OBJECT))
			typeId = 5103; // Ocamera (Standard) — always available

		BaseObject* cam = BaseObject::Alloc(typeId);
		if (!cam) return "{\"ok\":false,\"error\":\"alloc failed\"}";

		// Copy editor camera pose + lens so the new camera frames the
		// SAME view the user is currently looking at. The expectation
		// (matches C4D's own "Cameras → New Camera"): nothing visually
		// changes when the viewport switches to the new camera.
		BaseDraw* bd = doc->GetActiveBaseDraw();
		if (bd)
		{
			BaseObject* editor = bd->GetEditorCamera();
			if (editor)
			{
				cam->SetMl(editor->GetMl());
				// Copy lens-related parameters from the editor camera so
				// the new view looks identical to what the user is looking
				// at. IDs from frameworks/.../description/ocamera.h.
				// SDK's ConstDescIDLevel template requires compile-time
				// constants, so each param is unrolled.
				auto copyParam = [&](const DescID& did)
				{
					GeData val;
					if (editor->GetParameter(did, val, DESCFLAGS_GET::NONE))
						cam->SetParameter(did, val, DESCFLAGS_SET::NONE);
				};
				copyParam(ConstDescIDLevel(CAMERA_FOCUS));               // focal length (mm)
				copyParam(ConstDescIDLevel(CAMERAOBJECT_APERTURE));      // sensor width (mm)
				copyParam(ConstDescIDLevel(CAMERAOBJECT_FILM_OFFSET_X));
				copyParam(ConstDescIDLevel(CAMERAOBJECT_FILM_OFFSET_Y));
				copyParam(ConstDescIDLevel(CAMERAOBJECT_TARGETDISTANCE));
				copyParam(ConstDescIDLevel(CAMERA_PROJECTION));          // perspective / parallel / etc
			}
		}

		// Name-uniquify the new camera. C4D's InsertObject does NOT
		// auto-uniquify; without this every Add Camera click produces
		// another object literally named "Camera". Walk every BaseObject
		// in the doc (recursively, since cameras often nest under nulls)
		// and find the lowest unused ".N" suffix on the base name.
		{
			const String baseName = cam->GetName();
			std::set<String> existingNames;
			std::function<void(BaseObject*)> collect = [&](BaseObject* op) {
				while (op)
				{
					existingNames.insert(op->GetName());
					if (op->GetDown()) collect(op->GetDown());
					op = op->GetNext();
				}
			};
			collect(doc->GetFirstObject());
			if (existingNames.find(baseName) != existingNames.end())
			{
				for (Int32 n = 1; n < 9999; ++n)
				{
					String candidate = baseName + "." + String::IntToString(n);
					if (existingNames.find(candidate) == existingNames.end())
					{
						cam->SetName(candidate);
						break;
					}
				}
			}
		}

		// Atomic undo wrap (per R3 / microsdk pattern). NEWOBJ is added
		// AFTER InsertObject (different from other undo types).
		// SetActiveObject also adds its own undo entry inside this block,
		// so one Ctrl+Z reverts cam + activation atomically. (The
		// addClip from JS is a separate undo step, per R3.)
		doc->StartUndo();
		doc->InsertObject(cam, nullptr, nullptr);  // OM root, top
		doc->AddUndo(UNDOTYPE::NEWOBJ, cam);
		doc->SetActiveObject(cam, SELECTION_NEW);
		doc->EndUndo();

		// Mint a session objectId + BaseLink, same as OM-drop does. The
		// objectId travels back to JS, gets stored on the new clip, and
		// is used by set-active-camera + render-queue flows to map back
		// to this BaseObject. BaseLink survives renames + save/load.
		const Int32 objectId = _nextObjectId++;
		{
			AutoAlloc<BaseLink> link;
			if (link)
			{
				link->SetLink(cam);
				_cameraLinks.emplace(objectId, std::move(link));
			}
		}

		// Build the ack. Send back the live name (matches what JS would
		// see if the user dragged this same cam from the OM) plus typeId
		// so JS knows whether it got the requested type or the fallback.
		std::string nameUtf8;
		{
			const String name = cam->GetName();
			Char* cstr = name.GetCStringCopy();
			if (cstr) { nameUtf8 = cstr; DeleteMem(cstr); }
		}

		// EventAdd so the OM repaints with the new camera + selection.
		// JS's downstream addClip + set-active-camera flow will handle
		// the viewport routing — no need to invalidate the BaseDraw here.
		EventAdd();

		std::string out = "{\"ok\":true,\"kind\":\"create-camera-ack\",\"objectId\":";
		out += std::to_string(objectId);
		out += ",\"typeId\":";
		out += std::to_string(typeId);
		out += ",\"name\":\"";
		for (char ch : nameUtf8)
		{
			if (ch == '"' || ch == '\\') out += '\\';
			out += ch;
		}
		out += "\"}";
		return out;
	}

	// Plan 4 commit 5 — selection-follows-playhead. JS resolves the
	// active clip at the playhead on scrub-end / playback-stop AND
	// document.hasFocus() is true; sends the clip's objectId here so
	// the camera appears in the OM (and its params populate the AM).
	// objectId of 0 means "no selection change" — JS uses that for
	// orphan clips (no live camera to select) and gap cases.
	// Shift one clip's referenced camera's keyframes (object tracks + every
	// tag's tracks) by `deltaFrames`, so the animation travels with the clip
	// when it moves on the timeline. Does NOT open its own undo block — the
	// caller (HandleSaveState) brackets this inside the SAME StartUndo/EndUndo
	// as the clip-position write, so one Ctrl+Z undoes the move AND the
	// keyframe shift together. Adds its own AddUndo(CHANGE, cam/tag) entries
	// into that open block.
	//
	// `refCount` = how many clips reference this objectId. >1 means a shared
	// camera; we skip rather than corrupt the other clip's animation
	// (constitution: a camera can appear in two shots at non-overlapping
	// ranges). Returns keys moved (0 on skip).
	Int32 ApplyKeyframeShift(BaseDocument* doc, Int32 objectId,
	                         Int32 deltaFrames, Int32 refCount)
	{
		if (!doc || deltaFrames == 0)
			return 0;
		if (refCount > 1)
		{
			GePrint("[Shotblocks] keyframe shift: camera shared by "_s +
				maxon::String::IntToString(refCount) +
				" clips — skipping to avoid corrupting the other clip's animation."_s);
			return 0;
		}
		BaseObject* cam = ResolveCameraForObjectId(doc, objectId);
		if (!cam)
			return 0;

		Int32 fps = doc->GetFps();
		if (fps <= 0)
			fps = 24;

		Int32 keysMoved = 0;
		auto shiftTracks = [&](CTrack* head)
		{
			for (CTrack* t = head; t; t = t->GetNext())
			{
				CCurve* c = t->GetCurve(CCURVE::CURVE, false);
				if (!c)
					continue;
				Int32 n = c->GetKeyCount();
				// SetTime can re-sort the curve. A uniform offset keeps
				// relative order, but iterate in the safe direction so an
				// intermediate state never makes two keys momentarily cross:
				// reverse for a positive shift (latest first), forward for a
				// negative shift (earliest first).
				if (deltaFrames > 0)
				{
					for (Int32 i = n - 1; i >= 0; --i)
					{
						CKey* k = c->GetKey(i);
						if (!k)
							continue;
						k->SetTime(c, k->GetTime() + BaseTime(deltaFrames, fps));
						++keysMoved;
					}
				}
				else
				{
					for (Int32 i = 0; i < n; ++i)
					{
						CKey* k = c->GetKey(i);
						if (!k)
							continue;
						k->SetTime(c, k->GetTime() + BaseTime(deltaFrames, fps));
						++keysMoved;
					}
				}
			}
		};

		// Caller owns the StartUndo/EndUndo; we only register the objects.
		doc->AddUndo(UNDOTYPE::CHANGE, cam);
		shiftTracks(cam->GetFirstCTrack());
		for (BaseTag* tag = cam->GetFirstTag(); tag; tag = tag->GetNext())
		{
			doc->AddUndo(UNDOTYPE::CHANGE, tag);
			shiftTracks(tag->GetFirstCTrack());
		}
		cam->SetDirty(DIRTYFLAGS::MATRIX | DIRTYFLAGS::CACHE);
		return keysMoved;
	}

	// Parse the optional "keyframeShifts":[{"objectId":N,"deltaFrames":D,
	// "refCount":R},...] array from a save-state body and apply each shift.
	// MUST be called inside the save-state StartUndo/EndUndo block.
	void ApplyKeyframeShiftsFromBody(BaseDocument* doc, const std::string& body)
	{
		auto arr = body.find("\"keyframeShifts\"");
		if (arr == std::string::npos)
			return;
		auto lb = body.find('[', arr);
		auto rb = (lb == std::string::npos) ? std::string::npos : body.find(']', lb);
		if (lb == std::string::npos || rb == std::string::npos)
			return;
		std::string::size_type p = lb + 1;
		while (p < rb)
		{
			auto ob = body.find('{', p);
			if (ob == std::string::npos || ob >= rb)
				break;
			auto oe = body.find('}', ob);
			if (oe == std::string::npos || oe > rb)
				break;
			std::string obj = body.substr(ob, oe - ob + 1);
			Int32 objectId    = ParseIntField(obj, "objectId");
			Int32 deltaFrames = ParseIntField(obj, "deltaFrames");
			Int32 refCount    = ParseIntField(obj, "refCount");
			ApplyKeyframeShift(doc, objectId, deltaFrames, refCount);
			p = oe + 1;
		}
	}

	// Retime (rescale) one clip's referenced camera's keyframes around a
	// fixed anchor frame, so the same motion fills the clip's new duration
	// when an EDGE is dragged with Alt held. Sibling of ApplyKeyframeShift
	// (which OFFSETS for a body move); this one SCALES for an edge retime.
	// Like the shift, it does NOT open its own undo block — the caller
	// (HandleSaveState) brackets it inside the SAME StartUndo/EndUndo as
	// the clip in/out write, so one Ctrl+Z undoes the trim AND the rescale.
	//
	// `anchorFrame` is the edge that did NOT move (out-edge drag anchors the
	// in-point; in-edge drag anchors the out-point). Each key at document
	// time `f` maps to `anchorFrame + round((f - anchorFrame) * newDur/oldDur)`.
	// We rescale ALL of the camera's (and tags') keys — the one-camera-per-
	// clip model, matching the Move feature — not just keys inside the clip
	// window. Rounded to whole frames (user decision).
	//
	// `refCount` shares ApplyKeyframeShift's shared-camera guard: >1 skips,
	// because rescaling a camera used by another clip would warp that clip's
	// animation too. Returns keys moved (0 on skip / no-op).
	Int32 ApplyKeyframeRetime(BaseDocument* doc, Int32 objectId,
	                          Int32 anchorFrame, Int32 oldDur, Int32 newDur,
	                          Int32 refCount)
	{
		if (!doc || oldDur <= 0 || newDur <= 0 || oldDur == newDur)
			return 0;
		if (refCount > 1)
		{
			GePrint("[Shotblocks] keyframe retime: camera shared by "_s +
				maxon::String::IntToString(refCount) +
				" clips — skipping to avoid corrupting the other clip's animation."_s);
			return 0;
		}
		BaseObject* cam = ResolveCameraForObjectId(doc, objectId);
		if (!cam)
			return 0;

		Int32 fps = doc->GetFps();
		if (fps <= 0)
			fps = 24;

		Int32 keysMoved = 0;
		// A key's new whole-frame time, anchored and rescaled. Integer math
		// (no Float on the wire) keeps the round exact at this boundary.
		auto remap = [&](Int32 f) -> Int32
		{
			Int64 num = (Int64)(f - anchorFrame) * (Int64)newDur;
			// Round-half-away-from-zero division by oldDur.
			Int64 q = (num >= 0)
				? (num + oldDur / 2) / oldDur
				: -((-num + oldDur / 2) / oldDur);
			return anchorFrame + (Int32)q;
		};

		auto retimeTracks = [&](CTrack* head)
		{
			for (CTrack* t = head; t; t = t->GetNext())
			{
				CCurve* c = t->GetCurve(CCURVE::CURVE, false);
				if (!c)
					continue;
				Int32 n = c->GetKeyCount();
				// SetTime re-sorts the curve. A monotonic rescale (newDur>0)
				// preserves key order, so iterate in the safe direction:
				// expanding (newDur>oldDur) spreads keys APART — move the
				// farthest-from-anchor first (reverse) so none transiently
				// crosses a neighbour; compressing pulls them together —
				// move the nearest first (forward).
				const bool expanding = newDur > oldDur;
				if (expanding)
				{
					for (Int32 i = n - 1; i >= 0; --i)
					{
						CKey* k = c->GetKey(i);
						if (!k)
							continue;
						Int32 f = (Int32)(k->GetTime().GetFrame(fps));
						k->SetTime(c, BaseTime(remap(f), fps));
						++keysMoved;
					}
				}
				else
				{
					for (Int32 i = 0; i < n; ++i)
					{
						CKey* k = c->GetKey(i);
						if (!k)
							continue;
						Int32 f = (Int32)(k->GetTime().GetFrame(fps));
						k->SetTime(c, BaseTime(remap(f), fps));
						++keysMoved;
					}
				}
			}
		};

		// Caller owns the StartUndo/EndUndo; we only register the objects.
		doc->AddUndo(UNDOTYPE::CHANGE, cam);
		retimeTracks(cam->GetFirstCTrack());
		for (BaseTag* tag = cam->GetFirstTag(); tag; tag = tag->GetNext())
		{
			doc->AddUndo(UNDOTYPE::CHANGE, tag);
			retimeTracks(tag->GetFirstCTrack());
		}
		cam->SetDirty(DIRTYFLAGS::MATRIX | DIRTYFLAGS::CACHE);
		return keysMoved;
	}

	// Parse the optional "keyframeRetimes":[{"objectId":N,"anchorFrame":A,
	// "oldDur":O,"newDur":W,"refCount":R},...] array and apply each retime.
	// MUST be called inside the save-state StartUndo/EndUndo block. Mirrors
	// ApplyKeyframeShiftsFromBody.
	void ApplyKeyframeRetimesFromBody(BaseDocument* doc, const std::string& body)
	{
		auto arr = body.find("\"keyframeRetimes\"");
		if (arr == std::string::npos)
			return;
		auto lb = body.find('[', arr);
		auto rb = (lb == std::string::npos) ? std::string::npos : body.find(']', lb);
		if (lb == std::string::npos || rb == std::string::npos)
			return;
		std::string::size_type p = lb + 1;
		while (p < rb)
		{
			auto ob = body.find('{', p);
			if (ob == std::string::npos || ob >= rb)
				break;
			auto oe = body.find('}', ob);
			if (oe == std::string::npos || oe > rb)
				break;
			std::string obj = body.substr(ob, oe - ob + 1);
			Int32 objectId    = ParseIntField(obj, "objectId");
			Int32 anchorFrame = ParseIntField(obj, "anchorFrame");
			Int32 oldDur      = ParseIntField(obj, "oldDur");
			Int32 newDur      = ParseIntField(obj, "newDur");
			Int32 refCount    = ParseIntField(obj, "refCount");
			ApplyKeyframeRetime(doc, objectId, anchorFrame, oldDur, newDur, refCount);
			p = oe + 1;
		}
	}

	std::string HandleSelectInOm(const std::string& body)
	{
		Int32 objectId = ParseIntField(body, "objectId");
		if (objectId <= 0) return "{\"ok\":true,\"kind\":\"select-in-om-ack\",\"selected\":false}";
		BaseDocument* doc = GetActiveDocument();
		if (!doc) return "{\"ok\":false,\"error\":\"no doc\"}";
		auto it = _cameraLinks.find(objectId);
		if (it == _cameraLinks.end() || !it->second)
			return "{\"ok\":true,\"kind\":\"select-in-om-ack\",\"selected\":false}";
		BaseObject* cam = static_cast<BaseObject*>(it->second->GetLink(doc));
		if (!cam) return "{\"ok\":true,\"kind\":\"select-in-om-ack\",\"selected\":false}";
		doc->SetActiveObject(cam, SELECTION_NEW);
		EventAdd();
		return "{\"ok\":true,\"kind\":\"select-in-om-ack\",\"selected\":true}";
	}

	// Plan 4.1 commit 2 — rebuild the hidden Stage helper's animation
	// track on STAGEOBJECT_CLINK from the per-boundary event list JS
	// computed via lib/stageCameras.ts.
	//
	// CRITICAL: the DescID must use creator=Ostage (5136). Without it
	// the track lives in a different namespace from the parameter the
	// renderer reads — keys visually appear but are inert. Verified by
	// dumping a working hand-keyed Stage in C4D (plan-4.1 dump-stage
	// spike): a working CKey has DescID(level0_id=1100, dtype=133,
	// creator=5136). Three prior failed attempts all passed creator=0.
	//
	// Body shape:
	//   {"kind":"set-stage-cameras","events":[{"frame":0,"objectId":1},
	//                                          {"frame":72,"objectId":2}, ...]}
	std::string HandleSetStageCameras(const std::string& body)
	{
		BaseDocument* doc = GetActiveDocument();
		if (!doc) return "{\"ok\":false,\"error\":\"no doc\"}";
		BaseObject* stage = GetOrCreateStageHelper(doc);
		if (!stage) return "{\"ok\":false,\"error\":\"stage helper alloc failed\"}";

		// Cache the events too — useful for the driver tag's Enable
		// toggle and for diagnostics.
		std::vector<StageCameraEvent> next;
		auto pos = body.find("\"events\"");
		if (pos != std::string::npos)
		{
			pos = body.find('[', pos);
			if (pos != std::string::npos)
			{
				++pos;
				while (pos < body.size() && body[pos] != ']')
				{
					if (body[pos] != '{') { ++pos; continue; }
					const auto objStart = pos;
					const auto objEnd = body.find('}', pos);
					if (objEnd == std::string::npos) break;
					const std::string objBody = body.substr(objStart, objEnd - objStart + 1);
					StageCameraEvent ev;
					ev.frame    = ParseIntField(objBody, "frame");
					ev.objectId = ParseIntField(objBody, "objectId");
					next.push_back(ev);
					pos = objEnd + 1;
				}
			}
		}
		_stageEvents = std::move(next);

		// Build the animation track with the CORRECT DescID (creator=
		// Ostage). Flush existing keys for a fresh rebuild.
		const DescID clinkDid = ConstDescID(DescLevel(STAGEOBJECT_CLINK, DTYPE_BASELISTLINK, Ostage));
		CTrack* track = stage->FindCTrack(clinkDid);
		if (track)
		{
			CCurve* curve = track->GetCurve();
			if (curve) curve->FlushKeys();
		}
		else
		{
			track = CTrack::Alloc(stage, clinkDid);
			if (!track) return "{\"ok\":false,\"error\":\"CTrack::Alloc failed\"}";
			stage->InsertTrackSorted(track);
		}
		CCurve* curve = track->GetCurve();
		if (!curve) return "{\"ok\":false,\"error\":\"no curve\"}";

		const Int32 fps = doc->GetFps();
		const Int32 nowFrame = doc->GetTime().GetFrame(fps);
		BaseObject* nowCam = nullptr;
		Int32 nowCamBestFrame = -1;
		Int keyCount = 0;
		for (const auto& ev : _stageEvents)
		{
			CKey* k = curve->AddKey(BaseTime(ev.frame, fps));
			if (!k) continue;
			BaseObject* cam = nullptr;
			if (ev.objectId > 0)
			{
				auto it = _cameraLinks.find(ev.objectId);
				if (it != _cameraLinks.end() && it->second)
				{
					cam = static_cast<BaseObject*>(it->second->GetLink(doc));
					if (!cam) cam = static_cast<BaseObject*>(it->second->ForceGetLink());
				}
			}
			// STEP semantics: the active camera at nowFrame is the one from
			// the latest event at or before nowFrame.
			if (ev.frame <= nowFrame && ev.frame > nowCamBestFrame)
			{
				nowCamBestFrame = ev.frame;
				nowCam = cam;
			}
			GeData ld;
			ld.SetBaseList2D(cam);
			k->SetGeData(curve, ld);
			k->SetInterpolation(curve, CINTERPOLATION::STEP);
			++keyCount;
		}
		// Seed the STATIC STAGEOBJECT_CLINK with the current-frame camera
		// so the field is populated even while the Stage is dormant. The
		// keyframe track is what actually drives render-time switching;
		// this static value is a harmless seed (Enable=OFF gates it).
		{
			const DescID staticDid = ConstDescID(DescLevel(STAGEOBJECT_CLINK, DTYPE_BASELISTLINK, Ostage));
			GeData sd;
			sd.SetBaseList2D(nowCam);
			stage->SetParameter(staticDid, sd, DESCFLAGS_SET::NONE);
		}
		// Force the animation system to pick up the rebuilt track and
		// write the animated link onto the Stage's static STAGEOBJECT_CLINK
		// at the current time. Without the dirty + AnimateObject pass the
		// static Camera field stays empty and the renderer (which snapshots
		// the static value) never sees a camera.
		curve->SetKeyDirty();
		stage->SetDirty(DIRTYFLAGS::DATA | DIRTYFLAGS::CACHE);
		doc->AnimateObject(stage, doc->GetTime(), ANIMATEFLAGS::NONE);
		EventAdd();

		std::string out = "{\"ok\":true,\"kind\":\"set-stage-cameras-ack\",\"keys\":";
		out += std::to_string((long long)keyCount);
		out += "}";
		return out;
	}

	// Individual-shots branch of add-to-queue.
	//
	// Strategy (locked in by the Commit 7 SDK audit, see
	// .agent/plans/v1-plan-2-markers-and-render.md):
	//   - One Take per shot, named Shotblocks_<cameraName>. Find-or-
	//     create — second run of Add-to-Queue updates in place rather
	//     than minting Shotblocks_X (2).
	//   - Each Take overrides the active camera + the master
	//     RenderData's RDATA_FRAMEFROM / RDATA_FRAMETO via
	//     BaseTake::FindOrAddOverrideParam. We deliberately don't
	//     SetRenderData — the user's existing AOVs / format / output
	//     template stay shared across every Shotblocks Take.
	//   - Add the saved doc to the queue N times, one entry per shot,
	//     and SetActiveTakeIndex per entry. The take index is the
	//     position in the flat tree-walk that GetAllTakeNames returns.
	std::string HandleAddToQueueIndividual(BaseDocument* doc, const Filename& docPath, const std::string& body)
	{
		std::vector<ShotIn> shots = ParseShotsArray(body);
		if (shots.empty())
			return "{\"ok\":false,\"error\":\"no shots\",\"status\":\"No shots to render\"}";

		TakeData* takeData = doc->GetTakeData();
		if (!takeData)
			return "{\"ok\":false,\"error\":\"no takedata\",\"status\":\"Take system unavailable\"}";

		RenderData* masterRD = doc->GetActiveRenderData();
		if (!masterRD)
			return "{\"ok\":false,\"error\":\"no renderdata\",\"status\":\"No active Render Settings\"}";

		BaseTake* mainTake = takeData->GetMainTake();
		if (!mainTake)
			return "{\"ok\":false,\"error\":\"no main take\",\"status\":\"Main Take missing\"}";

		const Int32 fps = doc->GetFps();

		// Resolve every shot's camera up-front. Drops orphans (objectId
		// not registered, or the BaseLink resolves to nullptr) so the
		// rest of the function only walks healthy shots. We still keep
		// the count for the status line.
		struct Resolved { ShotIn shot; BaseObject* cam; String takeName; };
		std::vector<Resolved> healthy;
		Int32 orphans = 0;
		for (const ShotIn& s : shots)
		{
			BaseObject* cam = nullptr;
			auto it = _cameraLinks.find(s.objectId);
			if (it != _cameraLinks.end() && it->second)
				cam = static_cast<BaseObject*>(it->second->GetLink(doc));
			if (!cam) { ++orphans; continue; }

			// Take name: Shotblocks_<cameraName>. If the JS name is
			// empty (camera unnamed), fall back to the live OM name.
			// The take name itself is purely a label; render output
			// goes wherever the user's Render Settings path points.
			cinema::String label;
			if (!s.name.empty())
				label = cinema::String(s.name.c_str());
			else
				label = cam->GetName();
			if (label.GetLength() == 0)
				label = cinema::String("shot");
			Resolved r;
			r.shot = s;
			r.cam = cam;
			r.takeName = cinema::String("Shotblocks_") + label;
			healthy.push_back(std::move(r));
		}

		if (healthy.empty())
		{
			char buf[128];
			_snprintf_s(buf, sizeof(buf), _TRUNCATE,
				"{\"ok\":false,\"error\":\"all-orphan\",\"status\":\"All shots are orphan \xe2\x80\x94 nothing to queue\"}");
			return buf;
		}

		// Wrap Take creation + camera + parameter overrides in a single
		// undo block. FindOrAddOverrideParam / SetCamera / AddTake all
		// AddUndo internally — we just need to bracket them so one
		// Ctrl+Z reverts the whole Add-to-Queue.
		doc->StartUndo();

		for (Resolved& r : healthy)
		{
			BaseTake* take = FindShotblocksTake(takeData, r.takeName);
			if (!take)
				take = takeData->AddTake(r.takeName, nullptr, nullptr);
			if (!take)
				continue;

			take->SetCamera(takeData, r.cam);

			// RenderData per-parameter overrides via BaseTake::
			// FindOrAddOverrideParam are silently rejected in C4D 2026
			// even with every OVERRIDEENABLING bit on and the take set
			// current. OverrideNode fails too — the take system refuses
			// any override of RenderData via the public API. Workaround:
			// clone the master RenderData per shot, set the range on
			// the clone's container directly, and attach via
			// BaseTake::SetRenderData. AOVs / format / output path /
			// VideoPosts are deep-cloned by GetClone(COPYFLAGS::NONE),
			// so a fresh-master Add-to-Queue picks them up. A future
			// Sync Render Settings button will refresh the clones in
			// place when the master drifts.
			RenderData* clone = FindShotblocksRenderData(doc, r.takeName);
			if (!clone)
			{
				clone = static_cast<RenderData*>(masterRD->GetClone(COPYFLAGS::NONE, nullptr));
				if (!clone) continue;
				clone->SetName(r.takeName);
				doc->InsertRenderDataLast(clone);
			}

			// outFrame is exclusive (JS convention) — RDATA_FRAMETO is
			// inclusive, so subtract one. Single-frame clips
			// (outFrame == inFrame + 1) render the in-frame only.
			BaseTime tFrom(r.shot.inFrame, fps);
			BaseTime tTo(r.shot.outFrame - 1, fps);
			BaseContainer& bc = clone->GetDataInstanceRef();
			bc.SetInt32(RDATA_FRAMESEQUENCE, RDATA_FRAMESEQUENCE_MANUAL);
			bc.SetTime(RDATA_FRAMEFROM, tFrom);
			bc.SetTime(RDATA_FRAMETO,   tTo);

			take->SetRenderData(takeData, clone);
		}

		doc->EndUndo();

		// The Render Queue reads takes from the .c4d on DISK, not from
		// the live document — so the Shotblocks_* takes we just added
		// don't exist as far as the queue is concerned until we save.
		// Calling SetActiveTakeIndex with an index past the saved
		// file's take count crashes inside C4D (observed: hard crash
		// on a fresh doc that only had Main when saved). Save before
		// AddFile.
		if (!SaveDocument(doc, docPath, SAVEDOCUMENTFLAGS::DONTADDTORECENTLIST, FORMAT_C4DEXPORT))
			return "{\"ok\":false,\"error\":\"save failed\",\"status\":\"Could not save scene\"}";

		BatchRender* br = GetBatchRender();
		if (!br)
			return "{\"ok\":false,\"error\":\"no batchrender\",\"status\":\"Render Queue unavailable\"}";

		Int32 added = 0;
		for (Resolved& r : healthy)
		{
			if (!br->AddFile(docPath, 1 << 30))
				continue;
			Int32 entryIdx = br->GetElementCount() - 1;

			// Pick the Shotblocks_<name> Take for this entry.
			// GetAllTakeNames gives the authoritative tree-walk order
			// that SetActiveTakeIndex consumes. takeOnly=true: we set
			// the render-settings explicitly below — letting the queue
			// derive them from the Take doesn't actually pick up
			// take->SetRenderData (verified empirically Round 12).
			maxon::BaseArray<cinema::String> takeNames;
			br->GetAllTakeNames(entryIdx, takeNames);
			Int32 takeCount = br->GetTakeCount(entryIdx);
			Int32 takeIdx = -1;
			for (Int32 i = 0; i < takeNames.GetCount() && i < takeCount; ++i)
			{
				if (takeNames[i] == r.takeName) { takeIdx = i; break; }
			}
			if (takeIdx >= 0 && takeIdx < takeCount)
				br->SetActiveTakeIndex(entryIdx, takeIdx, true);

			// Same dance for render settings — the clone we just
			// created lives in the doc's RenderData list, but the queue
			// entry defaults to the doc's active RD. Look the clone up
			// by name and set the entry's active render-settings index
			// so the range/AOVs from the clone are what gets rendered.
			maxon::BaseArray<cinema::String> rsNames;
			br->GetAllRenderSettingsNames(entryIdx, rsNames);
			Int32 rsCount = br->GetRenderSettingsCount(entryIdx);
			Int32 rsIdx = -1;
			for (Int32 i = 0; i < rsNames.GetCount() && i < rsCount; ++i)
			{
				if (rsNames[i] == r.takeName) { rsIdx = i; break; }
			}
			if (rsIdx >= 0 && rsIdx < rsCount)
				br->SetActiveRenderSettingsIndex(entryIdx, rsIdx);

			// Per-entry CAMERA. The queue entry has its own camera index,
			// SEPARATE from the take's SetCamera, and it WINS at render
			// time. With takeOnly=true above, the entry stays on its
			// default camera (index 0 = "Default") for every shot — which
			// is why all shots rendered the same camera. Set it explicitly
			// to this shot's camera. GetAllCameraNames is 0-based but
			// SetActiveCameraIndex expects that index + 1 (0 == Default).
			maxon::BaseArray<cinema::String> camNames;
			br->GetAllCameraNames(entryIdx, camNames);
			Int32 camCount = br->GetCameraCount(entryIdx);
			const cinema::String wantCam = r.cam->GetName();
			Int32 camPos = -1;
			for (Int32 i = 0; i < camNames.GetCount() && i < camCount; ++i)
			{
				if (camNames[i] == wantCam) { camPos = i; break; }
			}
			if (camPos >= 0)
				br->SetActiveCameraIndex(entryIdx, camPos + 1);
			++added;
		}

		// EventAdd so the Take Manager redraws with the new takes.
		EventAdd();
		br->Open();

		// Snapshot the master RD container so we can detect drift on
		// subsequent EVMSG_CHANGE and light the Sync button.
		SnapshotMasterRenderSettings(doc);
		PushRenderSettingsDrift(doc);

		char buf[256];
		if (orphans > 0)
			_snprintf_s(buf, sizeof(buf), _TRUNCATE,
				"{\"ok\":true,\"kind\":\"add-to-queue-ack\",\"status\":\"Added %d shot%s \xc2\xb7 skipped %d orphan%s\"}",
				(int)added, added == 1 ? "" : "s",
				(int)orphans, orphans == 1 ? "" : "s");
		else
			_snprintf_s(buf, sizeof(buf), _TRUNCATE,
				"{\"ok\":true,\"kind\":\"add-to-queue-ack\",\"status\":\"Added %d shot%s to Render Queue\"}",
				(int)added, added == 1 ? "" : "s");
		return buf;
	}

	// JS-driven "Sync Render Settings" command. For every Shotblocks_*
	// RenderData in the doc, preserve its per-shot frame range, then
	// rebuild the entire clone from the current master so AOVs /
	// multipass / VideoPosts / output template all refresh together.
	// Container-only replacement isn't enough — AOVs live in CHILDREN
	// of the RD, not in its container.
	//
	// Strategy: for each Shotblocks_* RD, capture its name + the takes
	// pointing at it, free it, re-clone master with the same name,
	// re-insert, re-attach to the same takes, restore range. Net effect
	// is identical to deleting + re-running the Individual-shots half
	// of Add-to-Queue, but doesn't touch the Render Queue.
	std::string HandleSyncRenderSettings(const std::string& /*body*/)
	{
		BaseDocument* doc = GetActiveDocument();
		if (!doc)
			return "{\"ok\":false,\"error\":\"no doc\",\"status\":\"No active document\"}";
		// Use the SNAPSHOTTED master, not GetActiveRenderData(). The
		// user may have switched the active RD to one of our clones
		// before hitting Sync; we want to refresh against the original
		// master either way. Falls back to active if we have no
		// snapshot yet (shouldn't happen in normal flow since the
		// button only lights after Add-to-Queue).
		RenderData* masterRD = GetSnapshottedMasterRD(doc);
		if (!masterRD)
			masterRD = doc->GetActiveRenderData();
		if (!masterRD)
			return "{\"ok\":false,\"error\":\"no renderdata\",\"status\":\"No active Render Settings\"}";
		TakeData* takeData = doc->GetTakeData();

		// Collect work first — mutating the RD list while walking it
		// is unsafe. Each entry captures everything needed to replace
		// the old RD: name, preserved range, and any takes that point
		// at it.
		struct SyncJob {
			cinema::String name;
			RenderData* oldRD;
			BaseTime savedFrom;
			BaseTime savedTo;
			Int32 savedSeq;
			std::vector<BaseTake*> takes;
		};
		std::vector<SyncJob> jobs;
		for (RenderData* rd = doc->GetFirstRenderData(); rd; rd = rd->GetNext())
		{
			cinema::String n = rd->GetName();
			if (!(n.GetLength() >= 11 && n.SubStr(0, 11) == cinema::String("Shotblocks_")))
				continue;
			SyncJob j;
			j.name = n;
			j.oldRD = rd;
			BaseContainer& bc = rd->GetDataInstanceRef();
			j.savedFrom = bc.GetTime(RDATA_FRAMEFROM);
			j.savedTo   = bc.GetTime(RDATA_FRAMETO);
			j.savedSeq  = bc.GetInt32(RDATA_FRAMESEQUENCE);
			// Find takes pointing at this RD.
			if (takeData)
			{
				BaseTake* main = takeData->GetMainTake();
				for (BaseTake* t = main ? main->GetDown() : nullptr; t; t = t->GetNext())
				{
					if (t->GetRenderData(takeData) == rd)
						j.takes.push_back(t);
				}
			}
			jobs.push_back(std::move(j));
		}

		doc->StartUndo();
		for (SyncJob& j : jobs)
		{
			// Build the replacement first so AddUndo's snapshot of the
			// OLD node is valid at undo time.
			RenderData* fresh = static_cast<RenderData*>(masterRD->GetClone(COPYFLAGS::NONE, nullptr));
			if (!fresh) continue;
			fresh->SetName(j.name);
			BaseContainer& fbc = fresh->GetDataInstanceRef();
			fbc.SetInt32(RDATA_FRAMESEQUENCE, j.savedSeq);
			fbc.SetTime(RDATA_FRAMEFROM, j.savedFrom);
			fbc.SetTime(RDATA_FRAMETO,   j.savedTo);

			// Insert fresh before the old, then drop the old. This keeps
			// list ordering predictable across syncs.
			doc->InsertRenderData(fresh, nullptr, j.oldRD->GetPred());
			for (BaseTake* t : j.takes)
				t->SetRenderData(takeData, fresh);
			doc->AddUndo(UNDOTYPE::DELETEOBJ, j.oldRD);
			j.oldRD->Remove();
			RenderData::Free(j.oldRD);
		}
		doc->EndUndo();

		// New baseline + tell JS we're in sync.
		SnapshotMasterRenderSettings(doc);
		PushRenderSettingsDrift(doc);
		EventAdd();

		char buf[128];
		_snprintf_s(buf, sizeof(buf), _TRUNCATE,
			"{\"ok\":true,\"kind\":\"sync-render-settings-ack\",\"synced\":%d}",
			(int)jobs.size());
		return buf;
	}

	// Walk the doc's RenderData list looking for the per-shot clone
	// we created on a prior Add-to-Queue run. Keeps repeated runs
	// idempotent (update in place, never duplicate Shotblocks_X (1)).
	RenderData* FindShotblocksRenderData(BaseDocument* doc, const String& name)
	{
		if (!doc) return nullptr;
		for (RenderData* rd = doc->GetFirstRenderData(); rd; rd = rd->GetNext())
		{
			if (rd->GetName() == name)
				return rd;
		}
		return nullptr;
	}

	// Walk the Main Take's direct children for a take named `name`.
	// Used to keep Shotblocks_<X> takes unique across repeated Add-to-
	// Queue runs (find-first, create-if-missing). Children-of-Main only
	// is enough — that's where AddTake(parent=nullptr) puts new takes.
	BaseTake* FindShotblocksTake(TakeData* takeData, const String& name)
	{
		if (!takeData) return nullptr;
		BaseTake* main = takeData->GetMainTake();
		if (!main) return nullptr;
		for (BaseTake* t = main->GetDown(); t; t = t->GetNext())
		{
			if (t->GetName() == name)
				return t;
		}
		return nullptr;
	}

	// True if any RenderData in the doc is one of ours (named
	// Shotblocks_*). Drift detection only matters when there's at
	// least one clone to keep in sync.
	Bool HasShotblocksRenderData(BaseDocument* doc)
	{
		if (!doc) return false;
		for (RenderData* rd = doc->GetFirstRenderData(); rd; rd = rd->GetNext())
		{
			cinema::String n = rd->GetName();
			// "Shotblocks_" is 11 chars
			if (n.GetLength() >= 11 && n.SubStr(0, 11) == cinema::String("Shotblocks_"))
				return true;
		}
		return false;
	}

	// Compute a fingerprint that changes whenever anything materially
	// changes about the master RenderData. BaseContainer::operator==
	// catches the RD's top-level fields (format, output path, frame
	// rate, multipass flags) but NOT child-tree edits — and AOVs are
	// stored as CHILDREN of the RD, not container fields. The
	// fingerprint walks:
	//   - the RD itself: BaseContainer's GetDirty() seed + name
	//   - children recursively (multipass nodes / AOV layers / etc):
	//     name + type + dirty count
	// GetDirty() is C4D's monotonic version counter for a node, so
	// any edit anywhere in the node bumps it. Recurse to catch
	// AOV-internal edits too. Cheap; runs on EVMSG_CHANGE only.
	// Append a GeData's value to `out` in a stable text form. Only
	// scalars contribute hashable bytes; vectors / strings / basetimes
	// have their scalar parts pulled out. Custom-data types we don't
	// know about contribute their type id only — better than nothing
	// and safe across SDK versions.
	static void AppendGeDataValue(std::string& out, const GeData* g)
	{
		if (!g) { out += "_"; return; }
		Int32 t = g->GetType();
		out += "t"; out += std::to_string((unsigned long long)t); out += "=";
		switch (t)
		{
			case DA_LONG:
				out += std::to_string((long long)g->GetInt32());
				break;
			case DA_LLONG:
				out += std::to_string((long long)g->GetInt64());
				break;
			case DA_REAL:
				out += std::to_string((double)g->GetFloat());
				break;
			case DA_TIME:
			{
				BaseTime bt = g->GetTime();
				out += std::to_string((double)bt.Get());
				break;
			}
			case DA_VECTOR:
			{
				Vector v = g->GetVector();
				out += std::to_string((double)v.x); out += ",";
				out += std::to_string((double)v.y); out += ",";
				out += std::to_string((double)v.z);
				break;
			}
			case DA_STRING:
			{
				Char* nc = g->GetString().GetCStringCopy();
				out += nc ? nc : "";
				if (nc) DeleteMem(nc);
				break;
			}
			case DA_FILENAME:
			{
				Char* nc = g->GetFilename().GetString().GetCStringCopy();
				out += nc ? nc : "";
				if (nc) DeleteMem(nc);
				break;
			}
			default:
				// Custom data types — opaque to us. Skip the value;
				// the type id is already part of the fingerprint above.
				break;
		}
	}

	// Serialize a BaseContainer into a stable string. Walks every
	// (id, GeData) pair so any container mutation moves the string,
	// without depending on GetDirty (which lies during UI navigation).
	static void AppendContainer(std::string& out, const BaseContainer& bc)
	{
		Int32 i = 0;
		while (true)
		{
			Int32 id = bc.GetIndexId(i);
			if (id == NOTOK) break;
			const GeData* g = bc.GetIndexData(i);
			out += "[";
			out += std::to_string((long long)id);
			out += ":";
			AppendGeDataValue(out, g);
			out += "]";
			++i;
		}
	}

	std::string ComputeRenderSettingsFingerprint(RenderData* rd)
	{
		std::string out;
		if (!rd) return out;
		out.reserve(2048);
		// Walk the RD and every descendant. For each node, fingerprint
		// type + name + full container serialization. GetDirty isn't
		// reliable — C4D pokes it on tab navigation in the Render
		// Settings panel even when nothing's been edited. Walking the
		// container directly is the only ground truth.
		std::function<void(BaseList2D*)> walk = [&](BaseList2D* node) {
			if (!node) return;
			out += "{";
			out += std::to_string((unsigned long long)node->GetType());
			out += ":";
			Char* nc = node->GetName().GetCStringCopy();
			out += nc ? nc : "";
			if (nc) DeleteMem(nc);
			out += "|";
			AppendContainer(out, node->GetDataInstanceRef());
			out += "}";
			for (GeListNode* c = node->GetDown(); c; c = c->GetNext())
				walk(static_cast<BaseList2D*>(c));
		};
		walk(rd);
		// VideoPosts (Redshift, Octane, Standard Renderer, etc.) hang
		// off RenderData via a separate list — they are NOT children
		// reached by GetDown(). Each VideoPost holds its own settings
		// container, so we have to walk this list explicitly or
		// Redshift edits go undetected.
		for (BaseVideoPost* vp = rd->GetFirstVideoPost(); vp; vp = static_cast<BaseVideoPost*>(vp->GetNext()))
			walk(vp);
		return out;
	}

	// Cache a fingerprint of the master RD at this moment, plus a
	// BaseLink to it, so subsequent drift checks always fingerprint
	// the SAME node — not whatever happens to be active now. Without
	// the link, clicking a different preset in the render-settings
	// list would change GetActiveRenderData() and falsely register
	// as drift.
	void SnapshotMasterRenderSettings(BaseDocument* doc)
	{
		RenderData* masterRD = doc ? doc->GetActiveRenderData() : nullptr;
		if (!masterRD || !_renderSettingsSourceLink)
		{
			_renderSettingsSnapshotValid = false;
			return;
		}
		_renderSettingsSourceLink->SetLink(masterRD);
		_renderSettingsFingerprint = ComputeRenderSettingsFingerprint(masterRD);
		_renderSettingsSnapshotValid = true;
	}

	// Resolve the snapshotted-master RD back from its BaseLink. Null
	// if we never snapshotted, the doc changed, or the user deleted
	// that preset entirely.
	RenderData* GetSnapshottedMasterRD(BaseDocument* doc)
	{
		if (!_renderSettingsSnapshotValid || !_renderSettingsSourceLink || !doc)
			return nullptr;
		return static_cast<RenderData*>(_renderSettingsSourceLink->GetLink(doc));
	}

	// Push the current stale/in-sync state to JS if it changed since
	// the last push. JS uses this to grey/light the Sync button. Idle
	// docs (no Shotblocks_* clones in the OM) report stale=false so
	// the button stays inactive even if the user is making render
	// edits unrelated to Shotblocks.
	void PushRenderSettingsDrift(BaseDocument* doc)
	{
		if (!_htmlView || !_navigated) return;
		Bool hasClones = HasShotblocksRenderData(doc);
		Bool stale = false;
		if (hasClones)
		{
			RenderData* sourceRD = GetSnapshottedMasterRD(doc);
			if (sourceRD)
			{
				std::string cur = ComputeRenderSettingsFingerprint(sourceRD);
				stale = (cur != _renderSettingsFingerprint);
			}
		}
		if (stale == _lastPushedStale) return;
		_lastPushedStale = stale;
		char buf[96];
		_snprintf_s(buf, sizeof(buf), _TRUNCATE,
			"{\"kind\":\"render-settings-drift\",\"stale\":%s}",
			stale ? "true" : "false");
		_htmlView->PostWebMessage(maxon::String(buf));
	}

	// Resolve every objectId in _cameraLinks and push {id, alive, name}
	// to JS. JS uses this to flag orphan clips (alive=false) and to
	// keep clip labels in sync with OM renames. Called from
	// EVMSG_CHANGE so any OM mutation triggers a refresh, and from the
	// ping handshake so JS gets the initial snapshot on connect.
	void PostCameras()
	{
		if (!_htmlView || !_navigated)
			return;
		BaseDocument* doc = GetActiveDocument();
		if (!doc)
			return;
		maxon::String items("["_s);
		Bool first = true;
		for (auto& kv : _cameraLinks)
		{
			Int32 id = kv.first;
			BaseObject* op = kv.second
				? static_cast<BaseObject*>(kv.second->GetLink(doc))
				: nullptr;
			if (!first)
				items += ","_s;
			first = false;
			char hdr[64];
			_snprintf_s(hdr, sizeof(hdr), _TRUNCATE,
				"{\"id\":%d,\"alive\":%s,\"name\":\"",
				(int)id, op ? "true" : "false");
			items += maxon::String(hdr);
			if (op)
			{
				// Escape the name for JSON-string embedding. Names with
				// quotes / backslashes / control chars are rare but legal.
				String n = op->GetName();
				Char* nc = n.GetCStringCopy();
				std::string nameUtf8 = nc ? nc : "";
				if (nc) DeleteMem(nc);
				std::string esc;
				esc.reserve(nameUtf8.size() + 8);
				for (char c : nameUtf8)
				{
					if      (c == '\\') esc += "\\\\";
					else if (c == '"')  esc += "\\\"";
					else if (c == '\n') esc += "\\n";
					else if (c == '\r') esc += "\\r";
					else if (c == '\t') esc += "\\t";
					else                esc += c;
				}
				items += maxon::String(esc.c_str());
			}
			items += "\"}"_s;
		}
		items += "]"_s;
		maxon::String payload = "{\"kind\":\"cameras\",\"items\":"_s + items + "}"_s;
		_htmlView->PostWebMessage(payload);
	}

	// Static thunk referenced only so GetModuleHandleExW has a stable
	// address inside the DLL.
	static void DispatchHttpStatic() {}

	// --- Cursor ownership -------------------------------------------
	// The slip cursor wouldn't persist after a drag. WebView2's render
	// window is cross-process (can't subclass), and DOM/JS cursor
	// pokes don't drive the native cursor. The remaining suspect:
	// C4D's own dialog window handles WM_SETCURSOR for its region (the
	// HtmlViewerCustomGui is a child inside the C4D dialog) and resets
	// the cursor on every move. C4D's dialog HWND IS in our process,
	// so we CAN subclass it. When the slip cursor mode is on, our
	// WM_SETCURSOR handler sets the slip cursor and returns TRUE,
	// winning over both C4D and WebView2.
	//
	// `_cursorMode` is set by JS (`set-cursor-mode`): a tool-cursor id
	// to force, or 0 = let C4D/WebView2 decide. Atomic — HTTP worker
	// thread writes, UI thread's subclass proc reads. Mode ids match
	// CursorMode below.
	enum CursorMode {
		CURSOR_DEFAULT    = 0,
		CURSOR_SLIP       = 1,
		CURSOR_RAZOR      = 2,
		CURSOR_SELECT     = 3,
		CURSOR_AV_SPLIT   = 4,
		CURSOR_ROLL       = 5,
		CURSOR_PLAY_RANGE = 6,
		CURSOR_PEN        = 7,
		CURSOR_HAND       = 8,
		CURSOR_HAND_GRAB  = 9,
		CURSOR_ZOOM       = 10,
		CURSOR_RETIME     = 11,
	};

	// Load one multi-resolution .cur from <plugin>/web/cursors/.
	// LoadCursorFromFileW picks the DPI-appropriate image out of the
	// 32/48/64 set; LoadImage+LR_DEFAULTSIZE would force 32px.
	HCURSOR LoadCursorFile(const wchar_t* pluginDir, const wchar_t* file)
	{
		wchar_t curPath[MAX_PATH + 64];
		swprintf_s(curPath, MAX_PATH + 64, L"%sweb\\cursors\\%s", pluginDir, file);
		HCURSOR c = LoadCursorFromFileW(curPath);
		if (!c)
		{
			char u8[MAX_PATH + 64] = {0};
			WideCharToMultiByte(CP_UTF8, 0, curPath, -1, u8, sizeof(u8), nullptr, nullptr);
			GePrint(maxon::String("[Shotblocks/v2] cursor failed to load: ") + maxon::String(u8));
		}
		return c;
	}

	void LoadCursors()
	{
		if (_cursorsLoaded)
			return;
		_cursorsLoaded = true;
		HMODULE hMod = nullptr;
		GetModuleHandleExW(
			GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
			GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
			(LPCWSTR)&ShotblocksDialog::DispatchHttpStatic, &hMod);
		wchar_t path[MAX_PATH] = {0};
		GetModuleFileNameW(hMod, path, MAX_PATH);
		wchar_t* lastSlash = wcsrchr(path, L'\\');
		if (lastSlash)
			*(lastSlash + 1) = 0;
		// No select.cur — the Select tool uses the OS default cursor.
		_slipCursor    = LoadCursorFile(path, L"slip.cur");
		_razorCursor   = LoadCursorFile(path, L"razor.cur");
		_avSplitCursor   = LoadCursorFile(path, L"av-split.cur");
		_rollCursor      = LoadCursorFile(path, L"roll.cur");
		_playRangeCursor = LoadCursorFile(path, L"play-range.cur");
		_penCursor       = LoadCursorFile(path, L"pen.cur");
		_handCursor      = LoadCursorFile(path, L"hand.cur");
		_handGrabCursor  = LoadCursorFile(path, L"hand-grab.cur");
		_zoomCursor      = LoadCursorFile(path, L"zoom.cur");
		_retimeCursor    = LoadCursorFile(path, L"retime.cur");
		char b[256];
		_snprintf_s(b, sizeof(b), _TRUNCATE,
			"[Shotblocks/v2] cursors loaded: slip=%d razor=%d avsplit=%d roll=%d playrange=%d pen=%d hand=%d handgrab=%d zoom=%d retime=%d",
			_slipCursor ? 1 : 0, _razorCursor ? 1 : 0,
			_avSplitCursor ? 1 : 0, _rollCursor ? 1 : 0, _playRangeCursor ? 1 : 0,
			_penCursor ? 1 : 0,
			_handCursor ? 1 : 0, _handGrabCursor ? 1 : 0, _zoomCursor ? 1 : 0,
			_retimeCursor ? 1 : 0);
		GePrint(maxon::String(b));
	}

	// The cursor currently forced by JS, or null for "no override".
	HCURSOR CurrentForcedCursor()
	{
		switch (_cursorMode.load())
		{
			case CURSOR_SLIP:     return _slipCursor;
			case CURSOR_RAZOR:    return _razorCursor;
			// CURSOR_SELECT removed — Select tool uses the OS default.
			case CURSOR_AV_SPLIT:   return _avSplitCursor;
			case CURSOR_ROLL:       return _rollCursor;
			case CURSOR_PLAY_RANGE: return _playRangeCursor;
			case CURSOR_PEN:        return _penCursor;
			case CURSOR_HAND:       return _handCursor;
			case CURSOR_HAND_GRAB:  return _handGrabCursor;
			case CURSOR_ZOOM:       return _zoomCursor;
			case CURSOR_RETIME:     return _retimeCursor;
			default:                return nullptr;
		}
	}

	// Win32 timer id used (on the C4D dialog window) to re-assert the
	// slip cursor fast enough that WebView2's own cursor resets don't
	// produce a visible flicker.
	static const UINT_PTR kCursorTimerId = 0x5B1C;

	static LRESULT CALLBACK CursorSubclassProc(
		HWND hwnd, UINT msg, WPARAM wp, LPARAM lp,
		UINT_PTR /*id*/, DWORD_PTR refData)
	{
		auto* self = reinterpret_cast<ShotblocksDialog*>(refData);
		if (self)
		{
			HCURSOR forced = self->CurrentForcedCursor();
			if (forced)
			{
				// While a tool-cursor mode is on, re-assert it on
				// WM_SETCURSOR (mouse moved) AND on our fast WM_TIMER
				// (pointer still — WebView2 resets the cursor on its
				// own events; the timer overwrites it back before the
				// reset is visible).
				// Only force the cursor over the window's CLIENT area.
				// At the window borders / corner the hit-test code is
				// HTLEFT / HTBOTTOMRIGHT / etc. — leave those alone so
				// the OS resize cursor still shows. lp's low word is
				// the hit-test code on WM_SETCURSOR.
				if (msg == WM_SETCURSOR && LOWORD(lp) == HTCLIENT)
				{
					SetCursor(forced);
					return TRUE; // consumed — beats C4D + WebView2
				}
				if (msg == WM_TIMER && wp == kCursorTimerId)
				{
					// The fast timer re-asserts the cursor only when
					// the pointer is genuinely over the client area —
					// not parked on a resize border.
					POINT pt;
					if (GetCursorPos(&pt))
					{
						LRESULT ht = SendMessageW(hwnd, WM_NCHITTEST, 0,
							MAKELPARAM(pt.x, pt.y));
						if (ht == HTCLIENT)
							SetCursor(forced);
					}
				}
			}
		}
		if (msg == WM_NCDESTROY)
		{
			RemoveWindowSubclass(hwnd, &CursorSubclassProc, 1);
			if (self && self->_cursorSubclassed == hwnd)
				self->_cursorSubclassed = nullptr;
		}
		return DefSubclassProc(hwnd, msg, wp, lp);
	}

	// Subclass the C4D dialog window for WM_SETCURSOR. Called from
	// Timer() — cheap no-op once installed.
	void EnsureCursorSubclass()
	{
		if (_cursorSubclassed)
			return;
		HWND dlg = static_cast<HWND>(GetWindowHandle());
		if (!dlg)
			return;
		LoadCursors();
		if (SetWindowSubclass(dlg, &CursorSubclassProc, 1,
			reinterpret_cast<DWORD_PTR>(this)))
		{
			_cursorSubclassed = dlg;
			GePrint("[Shotblocks/v2] cursor subclass installed on C4D dialog"_s);
		}
	}

private:
	HtmlViewerCustomGui* _htmlView;
	bool                 _navigated;
	bool                 _serverStarted;
	bool                 _jsHandshakeDone;
	bool                 _hoverActive;
	Float                _lastTimeChangedTickMs;

	LocalHttpServer      _server;
	UInt16               _httpPort;

	std::mutex                   _queueMu;
	std::deque<HttpRequest>      _queue;

	std::string          _activeTool{"select"};

	// Cursor ownership — see the cursor block above.
	bool                 _cursorsLoaded{false};
	HCURSOR              _slipCursor{nullptr};
	HCURSOR              _razorCursor{nullptr};
	HCURSOR              _avSplitCursor{nullptr};
	HCURSOR              _rollCursor{nullptr};
	HCURSOR              _playRangeCursor{nullptr};
	HCURSOR              _penCursor{nullptr};
	HCURSOR              _handCursor{nullptr};
	HCURSOR              _handGrabCursor{nullptr};
	HCURSOR              _zoomCursor{nullptr};
	HCURSOR              _retimeCursor{nullptr};
	std::atomic<int>     _cursorMode{0};   // CursorMode id; 0 = no override
	HWND                 _cursorSubclassed{nullptr};

	// OM-drop camera registry. Each dragged BaseObject is assigned a
	// session-unique objectId; that id is sent to JS in the om-drop
	// payload and stored on the JS Clip. JS later sends
	// {kind:"set-active-camera", objectId:N} when the playhead enters
	// the clip's range; C++ resolves N via _cameraLinks and writes the
	// BaseObject to the pinned BaseDraw.
	//
	// BaseLink survives object deletion (resolves to null) — matches
	// Python's shot-orphan semantics where the timeline keeps the clip
	// but the camera link goes dead.
	std::unordered_map<Int32, AutoAlloc<BaseLink>> _cameraLinks;
	Int32                _nextObjectId{1};
	// Pinned BaseDraw target — selected on first camera-set call so
	// subsequent calls don't hijack other viewports (per Python
	// _pick_target_basedraw / sb_canvas_playback.py:192).
	BaseDraw*            _pinnedBaseDraw{nullptr};
	Int32                _currentActiveObjectId{0};
	// Plan 4.1 — cache of per-clip-boundary camera events that the
	// driver tag (Commit 3) reads each render frame to write the
	// Stage's static STAGEOBJECT_CLINK parameter. Pushed from JS via
	// set-stage-cameras on every timeline change. In-memory only;
	// re-pushed on JS save-state if the dialog is reloaded.
	std::vector<StageCameraEvent> _stageEvents;
	// Helper-version bookkeeping. Bumped on every save-state write;
	// EVMSG_CHANGE compares the current helper version against this
	// cached value to detect when Ctrl+Z / Ctrl+Y rolled the helper
	// back/forward to a different version, in which case we tell JS
	// to reload (push notification → state-changed message).
	Int32                _lastSeenVersion{0};
	// v2 playback delegates to C4D's native transport (RunAnimation);
	// see toggle-play and Timer(). _v2Playing tracks whether v2 started
	// the playback (vs C4D's own play button) so scrub-begin/end can
	// stop/resume it and PostTick can report v2-initiated play.
	Bool                 _v2Playing{false};
	// True while the user scrub-holds the v2 playhead during playback.
	// scrub-begin stops native play; scrub-end resumes it.
	Bool                 _v2ScrubPaused{false};
	Int32                _v2RangeIn{0};
	Int32                _v2RangeOut{1 << 30};
	Bool                 _v2LoopEnabled{false};
	// Last loop on/off (IsCommandChecked(12427)) the Timer pushed to JS.
	// -1 = unknown, so the first Timer tick bootstraps the ShotBlocks
	// toggle to C4D's current loop state. Also pre-written by the
	// set-loop handler to suppress the echo on JS-initiated toggles.
	Int32                _lastLoopChecked{-1};

	// Render-settings drift detection. Snapshot of the master
	// RenderData's container, taken at the end of every Add-to-Queue
	// (Individual shots) and every Sync. EVMSG_CHANGE re-reads master
	// and compares; mismatch → push render-settings-drift{stale:true}
	// so the Inspector can light the Sync button. Cleared (and stale
	// pushed as false) when there are no Shotblocks_* clones.
	std::string          _renderSettingsFingerprint;
	Bool                 _renderSettingsSnapshotValid{false};
	// BaseLink to the master RenderData that was active when we
	// snapshotted. Drift checks fingerprint THIS specific RD, not
	// whatever GetActiveRenderData() currently returns — otherwise
	// the Sync button lights whenever the user clicks a different
	// preset in the render-settings list, even though nothing
	// changed. Cleared on doc close / load.
	AutoAlloc<BaseLink>  _renderSettingsSourceLink;
	Bool                 _lastPushedStale{false};
};

// Plan 4.1 — singleton dialog pointer the driver tag reads to access
// _stageEvents + _cameraLinks per render-frame. Nullptr when the dialog
// isn't alive (renders won't switch in that case — acceptable since
// closing the dialog implies the user isn't expecting Shotblocks behavior).
ShotblocksDialog* ShotblocksDialog::s_instance = nullptr;

// ---------------------------------------------------------------------------
// Plan 4.1 commit 3 (architectural pivot 2) — Camera Driver tag.
//
// Attached to the hidden helper Onull (not the Stage — the Stage write
// path doesn't work from a tag's Execute). On every Execute call (which
// fires per frame during native scrub, native playback, and render),
// the tag computes which clip is active at the current frame and writes
// to BaseDraw::SetSceneCamera via the SetParameter recipe (the same
// path our live JS→C++ set-active-camera handler uses).
//
// This means Shotblocks camera switching works whether the dialog is
// open or closed, in interactive viewport AND in render. The dialog's
// live router (useActiveClipRouter) still handles instant scrub
// response when the dialog is open; the tag covers everything else.
//
// (g_shotblocks_stage_driver_id is defined at the top of the file —
// name kept for stability with the BC marker even though the tag's
// purpose has shifted away from the Stage.)
// ---------------------------------------------------------------------------

class ShotblocksStageDriverTag : public TagData
{
public:
	static NodeData* Alloc() { return NewObjClear(ShotblocksStageDriverTag); }

	// Run early in the priority pipeline so the BaseDraw's camera is
	// set BEFORE generators / expressions consume it. INITIAL (1000)
	// fires first.
	Bool AddToExecution(BaseTag* tag, PriorityList* list) override
	{
		if (list && tag)
			list->Add(tag, EXECUTIONPRIORITY_INITIAL, EXECUTIONFLAGS::NONE);
		return true;
	}

	// MSG_MULTI_RENDERNOTIFICATION fires here. Toggle the Stage helper's
	// Enable flag around the render lifecycle so its keyframed camera
	// link drives render-time camera switching.
	Bool Message(GeListNode* /*node*/, Int32 type, void* data) override
	{
		if (type == MSG_MULTI_RENDERNOTIFICATION && data)
		{
			RenderNotificationData* rn = static_cast<RenderNotificationData*>(data);
			// Mark render lifecycle so Execute skips its per-frame
			// BaseDraw write — Stage's keyframes drive during render.
			_rendering = rn->start;
			BaseDocument* doc = rn->doc ? rn->doc : GetActiveDocument();
			if (doc)
			{
				BaseObject* stage = FindStageHelper(doc);
				if (stage)
				{
					// Only enable the Stage for the render if it actually
					// has keyframes. In individual-shots render mode JS
					// flushes the Stage's track (empty), so it must NOT be
					// enabled — the Take system owns per-shot cameras and an
					// enabled empty Stage shouldn't participate. On render-
					// end always flip OFF regardless.
					// Only enable the Stage for the render if it has
					// keyframes. In individual-shots mode JS flushes the
					// track (empty) so the Stage stays inert and the Take
					// system owns per-shot cameras.
					Bool enable = false;
					if (rn->start)
					{
						const DescID did = ConstDescID(DescLevel(STAGEOBJECT_CLINK, DTYPE_BASELISTLINK, Ostage));
						CTrack* track = stage->FindCTrack(did);
						CCurve* curve = track ? track->GetCurve() : nullptr;
						enable = curve && curve->GetKeyCount() > 0;
					}
					stage->SetParameter(
						ConstDescIDLevel(ID_BASEOBJECT_GENERATOR_FLAG),
						GeData(enable), DESCFLAGS_SET::NONE);
					// Force the Enable flip to take before the renderer
					// snapshots the scene.
					stage->SetDirty(DIRTYFLAGS::DATA | DIRTYFLAGS::CACHE);
				}
			}
		}
		return TagData::Message(nullptr, type, data);
	}

	// Execute is intentionally a no-op. We previously had a per-frame
	// BaseDraw write here that routed cameras on native C4D scrub when
	// our dialog was closed — but it also forced the viewport onto the
	// active clip's camera every frame, preventing the user from
	// looking through any other camera. Removed by user request; we're
	// back to "cameras only switch when our dialog is open" (JS-driven
	// via useActiveClipRouter). The Stage helper drives render-time
	// camera switching via its keyframed camera link.
	EXECUTIONRESULT Execute(BaseTag* /*tag*/, BaseDocument* /*doc*/, BaseObject* /*op*/,
		BaseThread* /*bt*/, Int32 /*priority*/, EXECUTIONFLAGS /*flags*/) override
	{
		return EXECUTIONRESULT::OK;
	}

private:
	// Set true during MSG_MULTI_RENDERNOTIFICATION(start=true) and back
	// to false on (start=false). When true, Execute skips its per-frame
	// BaseDraw write so the Stage's keyframed camera link drives the
	// render without interference.
	Bool _rendering{false};
};


// ---------------------------------------------------------------------------
// Command + registration
// ---------------------------------------------------------------------------

class OpenShotblocksDialogCommand : public CommandData
{
public:
	OpenShotblocksDialogCommand() : _dlg(nullptr) {}

	Bool Execute(BaseDocument* /*doc*/, GeDialog* /*parentManager*/) override
	{
		if (!_dlg)
			_dlg = NewObjClear(ShotblocksDialog);
		if (!_dlg)
			return false;
		// Default window size matches the Figma reference layout
		// (ShotBlocks Edit frame 150:1348 — 1284 wide × 544 tall) plus
		// C4D's window chrome. Sized for an actual editing session
		// instead of the previous 700×400 placeholder. C4D will still
		// respect any saved layout (RestoreLayout below); these values
		// only apply when no saved layout exists.
		return _dlg->Open(DLG_TYPE::ASYNC, g_shotblocks_cmd_id, -1, -1, 1497, 594);
	}

	Bool RestoreLayout(void* secret) override
	{
		if (!_dlg)
			_dlg = NewObjClear(ShotblocksDialog);
		if (!_dlg)
			return false;
		return _dlg->RestoreLayout(g_shotblocks_cmd_id, 0, secret);
	}

private:
	ShotblocksDialog* _dlg;
};


// Load the command/menu icon from <plugin>/res/icons/sb_menu.png. The
// PNG ships via the Python deploy's /MIR of src/res/. Returns nullptr on
// failure (command still registers, just without an icon).
static BaseBitmap* LoadMenuIcon()
{
	HMODULE hMod = nullptr;
	GetModuleHandleExW(
		GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
		GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
		(LPCWSTR)&LoadMenuIcon, &hMod);
	wchar_t path[MAX_PATH] = {0};
	GetModuleFileNameW(hMod, path, MAX_PATH);
	wchar_t* lastSlash = wcsrchr(path, L'\\');
	if (lastSlash)
		*(lastSlash + 1) = 0;
	wcscat_s(path, MAX_PATH, L"res\\icons\\sb_menu.png");
	BaseBitmap* bmp = BaseBitmap::Alloc();
	if (!bmp)
		return nullptr;
	char u8[MAX_PATH * 2] = {0};
	WideCharToMultiByte(CP_UTF8, 0, path, -1, u8, sizeof(u8), nullptr, nullptr);
	Filename fn;
	fn.SetString(maxon::String(u8));
	if (bmp->Init(fn) != IMAGERESULT::OK)
	{
		BaseBitmap::Free(bmp);
		GePrint("[Shotblocks/v2] menu icon failed to load"_s);
		return nullptr;
	}
	return bmp;
}

static Bool RegisterShotblocksCommands()
{
	BaseBitmap* icon = LoadMenuIcon();
	const Bool ok = RegisterCommandPlugin(
		g_shotblocks_cmd_id,
		"Shotblocks"_s,
		0, icon,
		"Dockable web-based Shotblocks UI"_s,
		NewObjClear(OpenShotblocksDialogCommand));
	// RegisterCommandPlugin copies the bitmap; free our local copy.
	if (icon)
		BaseBitmap::Free(icon);
	return ok;
}

// Plan 4.1 commit 3 — register the hidden Stage Driver tag.
//   - TAG_EXPRESSION: Execute fires per frame in the priority pipeline.
//   - NO TAG_VISIBLE: tag doesn't show in OM's tag column.
//   - PLUGINFLAG_HIDE + PLUGINFLAG_HIDEPLUGINMENU: doesn't appear in
//     Create > New Tag menu either.
static Bool RegisterShotblocksStageDriver()
{
	return RegisterTagPlugin(
		g_shotblocks_stage_driver_id,
		"Shotblocks Stage Driver"_s,
		TAG_EXPRESSION | PLUGINFLAG_HIDE | PLUGINFLAG_HIDEPLUGINMENU,
		ShotblocksStageDriverTag::Alloc,
		""_s,        // no description resource — tag has no AM UI
		nullptr,     // no icon — invisible anyway
		0);
}


Bool cinema::PluginStart()
{
	if (!RegisterShotblocksCommands())
		return false;
	if (!RegisterShotblocksStageDriver())
		return false;
	GePrint("[Shotblocks/v2] PluginStart OK"_s);
	return true;
}

void cinema::PluginEnd()
{
}

Bool cinema::PluginMessage(Int32 id, void* /*data*/)
{
	switch (id)
	{
		case C4DPL_INIT_SYS:
			if (!g_resource.Init())
				return false;
			return true;
	}
	return false;
}
