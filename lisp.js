/* CyberLisp: A Lisp that compiles to JavaScript 1.5.

   Copyright (C) 2008 by Manuel Simoni.
   
   CyberLisp is free software; you can redistribute it and/or modify
   it under the terms of the GNU General Public License as published
   by the Free Software Foundation; either version 2, or (at your
   option) any later version.
   
   CyberLisp is distributed in the hope that it will be useful, but
   WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
   General Public License for more details.
   
   You should have received a copy of the GNU General Public License
   along with GNU Emacs; see the file COPYING.  If not, write to the
   Free Software Foundation, Inc., 51 Franklin Street, Fifth Floor,
   Boston, MA 02110-1301, USA. */

load("lib/jsparse.js");
load("lib/json2.js");


/*** Syntax ***/

/* CyberLisp does not use a cons-based representation for Lisp source.
   Instead, forms are represented as objects, which makes it possible
   to attach additional information to forms, e.g. file name and line
   number.  CyberLisp also has a separation between in-language
   datatypes (e.g. strings) and their syntactic representations
   (e.g. string forms).  A string form in the Lisp source is not a
   Lisp string: a string in the source (a string form) may have a line
   number or other metadata attached to it, whereas an in-language
   string is simply a string.

   There are multiple types of forms; number forms, string forms,
   symbol forms, and compound forms:
   
   1     --> { formt: "number", n: "1" }
   "foo" --> { formt: "string", s: "foo" }
   foo   --> { formt: "symbol", name: "foo" }
   (foo) --> { formt: "compound", 
               elts: [ { formt: "symbol", name: "foo" } ] } 
*/

var lisp_form =
    function(input) { return lisp_form(input); }; // forward decl.

/**** Number forms ****/

var lisp_digits = 
    join_action(repeat1(range("0", "9")), "");

var lisp_number_form =
    action(sequence(optional(choice("+", "-")),
                    lisp_digits,
                    optional(join_action(sequence(".", lisp_digits), ""))),
           lisp_number_form_action);

function lisp_number_form_action(ast)
{    
    var sign = ast[0] ? ast[0] : "";
    var decimal_digits = ast[1];
    var dot_digits = ast[2] ? ast[2] : "";
    return { formt: "number", n: sign + decimal_digits + dot_digits };
}

/**** String forms ****/

var lisp_escape_char =
    choice("\"", "\\");

var lisp_escape_sequence =
    action(sequence("\\", lisp_escape_char),
           lisp_escape_sequence_action);

var lisp_string_char =
    choice(negate(lisp_escape_char), 
           lisp_escape_sequence);

var lisp_string_form =
    action(sequence("\"", join_action(repeat0(lisp_string_char), ""), "\""),
           lisp_string_form_action);

function lisp_escape_sequence_action(ast)
{
    var escape_char = ast[1];
    return escape_char;
}

function lisp_string_form_action(ast)
{
    return { formt: "string", s: ast[1] };
}

/**** Symbol forms ****/

var lisp_symbol_special_char =
    // Needs to be in sync with `lisp_mangle_table'.
    choice("&", ":", ".", "=", ">","-", "<", "%", "+", "/", "*");

var lisp_symbol_form =
    action(join_action(repeat1(choice(range("a", "z"),
                                      range("0", "9"),
                                      lisp_symbol_special_char)),
                       ""),
           lisp_symbol_form_action);

function lisp_symbol_form_action(ast)
{
    return { formt: "symbol", name: ast };
}

/**** Compound forms ****/

var lisp_compound_form =
    action(sequence("(", repeat0(lisp_form), ")"),
           lisp_compound_form_action);

function lisp_compound_form_action(ast)
{
    return { formt: "compound", elts: ast[1] };
}

/**** Quasiquotation forms ****/

var lisp_quasiquote_form =
    action(sequence("`", lisp_form),
           lisp_make_qq_action("%%quasiquote"));

var lisp_unquote_form =
    action(sequence(",", lisp_form),
           lisp_make_qq_action("%%unquote"));

var lisp_unquote_splicing_form =
    action(sequence(",@", lisp_form),
           lisp_make_qq_action("%%unquote-splicing"));

function lisp_make_qq_action(name)
{
    return function(ast) {
        return { formt: "compound", 
                 elts: [ { formt: "symbol", name: name }, ast[1] ] };
    }
}

/**** Lisp programs ****/

var lisp_form =
    whitespace(choice(lisp_number_form,
                      lisp_string_form,
                      lisp_symbol_form,
                      lisp_compound_form,
                      lisp_quasiquote_form,
                      lisp_unquote_form,
                      lisp_unquote_splicing_form));

var lisp_forms =
    repeat1(lisp_form);

function lisp_parse(string)
{
    return lisp_forms(ps(string)).ast;
}


/*** Compilation and Evaluation ***/

function lisp_eval(string)
{
    var forms = lisp_parse(string);
    var vop = { vopt: "progn", vops: forms.map(lisp_compile) };
    var js = lisp_emit(vop);
    return eval(js);
}

/* The usual Lisp evaluation rule: literals evaluate to themselves;
   symbols evaluate to the value of the binding they name.  A compound
   form is evaluated differently depending on whether its first
   element names a special form, a macro, or a function: special form
   calls are evaluated with special evaluation rules, macro calls are
   first expanded and then compiled recursively, function calls are
   evaluated by applying the named function to the supplied
   arguments. */

function lisp_compile(form)
{
    switch(form.formt) {
    case "number": return lisp_compile_number_form(form);
    case "string": return lisp_compile_string_form(form);
    case "symbol": return lisp_compile_symbol_form(form);
    case "compound": return lisp_compile_compound_form(form);
    }
    lisp_error("Bad form", form);
}

function lisp_compile_number_form(form)
{
    lisp_assert_nonempty_string(form.n, "Bad .n", form);
    return { vopt: "number", n: form.n };
}

function lisp_compile_string_form(form)
{
    lisp_assert_string(form.s, "Bad .s", form);
    return { vopt: "string", s: form.s };
}

function lisp_compile_symbol_form(form)
{
    lisp_assert_symbol_form(form, "Bad symbol form", form);
    return { vopt: "ref", name: form.name };
}

function lisp_compile_compound_form(form)
{
    var op = lisp_assert_symbol_form(form.elts[0], "Bad operator", form);
    var special = lisp_special_function(op.name);
    if (special) {
        return special(form);
    } else {
        var macro = lisp_macro_function(op.name);
        if (macro) {
            // The macro function is a Lisp function, so the calling
            // convention must be followed.
            return lisp_compile(macro(null, form));
        } else {
            lisp_error("Bad form", form);
        }
    }
}


/*** Special forms ***/

/* Special forms are built-in forms with special evaluation rules
   (e.g. `%%if').  Special forms are very low-level, and generally not
   directly used by CyberLisp programmers.  The names of all special
   forms are prefixed with "%%", so more comfortable wrappers around
   them can be defined later (e.g. `if'). */

function lisp_special_function(name)
{
    lisp_assert_nonempty_string(name, "Bad special form name", name);
    return lisp_specials_table[name];
}

var lisp_specials_table = {
    "%%defparameter": lisp_compile_special_defparameter,
    "%%defun": lisp_compile_special_defun,
    "%%defmacro": lisp_compile_special_defmacro,
    "%%funcall": lisp_compile_special_funcall,
    "%%function": lisp_compile_special_function,
    "%%lambda": lisp_compile_special_lambda,
    "%%progn": lisp_compile_special_progn,
    "%%quasiquote": lisp_compile_special_quasiquote,
};

function lisp_macro_function(name)
{
    var name = lisp_assert_nonempty_string(name, "Bad macro name", name);
    var mangled_name = lisp_mangle_function(name);
    return lisp_macros_table[mangled_name];
}

function lisp_set_macro_function(name, expander)
{
    var name = lisp_assert_nonempty_string(name, "Bad macro name", name);
    var mangled_name = lisp_mangle_function(name);
    lisp_macros_table[mangled_name] = expander;
}

/* Maps the mangled names of macros to their expander functions. */
var lisp_macros_table = {};

/**** List of special forms ****/

/* Assigns the `value' to the global variable named `name'.
   (%%defparameter name value) */
function lisp_compile_special_defparameter(form)
{
    var name_form = lisp_assert_symbol_form(form.elts[1]);
    var value_form = lisp_assert_not_null(form.elts[2]);
    return { vopt: "set", 
             name: name_form.name, 
             value: lisp_compile(value_form) };
}

/* Assigns the `value' to the global function named `name'.
   (%%defun name value) */
function lisp_compile_special_defun(form)
{
    var name_form = lisp_assert_symbol_form(form.elts[1]);
    var value_form = lisp_assert_not_null(form.elts[2]);
    return { vopt: "fset", 
             name: name_form.name, 
             value: lisp_compile(value_form) };
}

/* Registers a macro expander function.  An expander function takes a
   form as input and must return a form.
   (%%defmacro name expander-function) */
function lisp_compile_special_defmacro(form)
{
    var name_form = lisp_assert_symbol_form(form.elts[1]);
    var expander_form = lisp_assert_not_null(form.elts[2]);
    return { vopt: "macroset", 
             name: name_form.name, 
             expander: lisp_compile(expander_form) };
}

/* Calls a function passed as argument.
   (%%funcall fun &rest args &all-keys keys) => result */
function lisp_compile_special_funcall(form)
{
    var fun = lisp_assert_not_null(form.elts[1]);
    var call_site = lisp_assert_not_null(form.elts.slice(2));
    return { vopt: "funcall",
             fun: lisp_compile(fun),
             call_site: lisp_compile_call_site(call_site) };
}

/* Accesses the functional value of a name.
   (%%function name) => function */
function lisp_compile_special_function(form)
{
    var name_form = lisp_assert_symbol_form(form.elts[1]);
    return { vopt: "fref", 
             name: name_form.name };
}

/* Returns a lexical closure.  See heading ``Functions''.
   (%%lambda sig body) */
function lisp_compile_special_lambda(form)
{
    lisp_assert_compound_form(form.elts[1]);
    var sig = form.elts[1].elts;
    var body = form.elts[2];
    return { vopt: "lambda", 
             sig: lisp_compile_sig(sig),
             body: lisp_compile(body) };
}

/* Evaluates a number of forms in sequence and returns the value of the last.
   (%%progn &rest forms) */
function lisp_compile_special_progn(form)
{
    var vops = form.elts.slice(1);
    return { vopt: "progn", 
             vops: vops.map(lisp_compile) };
}

/* See heading ``Quasiquotation''.
   (%%quasiquote form) */
function lisp_compile_special_quasiquote(form)
{
    var quasiquoted = lisp_assert_not_null(form.elts[1]);
    return lisp_compile_qq(quasiquoted, 0);
}


/*** Functions ***/

/**** Overview ****/

/* A function can have required, optional, keyword, rest, and all-keys
   parameters.  Required, optional, and keyword parameters can be
   typed.  Optional and keyword parameters can have default value
   expressions.  A rest parameter is bound to a sequence of any
   remaining positional arguments.  An all-keys parameter is bound to
   a dictionary of all keyword arguments passed to a function.
   
   Required and optional parameters are called positional, because
   they are bound from left to right. */
   
/**** Binding of parameters to arguments ****/

/* When a function is called, the function's required and optional
   parameters are bound to the positional arguments from left to
   right.  If there are remaining arguments, and the function defines
   a rest parameter, it is bound to a sequence containing the
   remaining arguments.  If the function defines keyword parameters,
   they are bound to the corresponding keyword arguments.  If the
   function defines an all-keys parameter, it is bound to a dictionary
   containing all keyword arguments, even those already bound to
   keyword parameters.

   In contrast to JavaScript, CyberLisp does not allow a function to
   be called with less positional arguments than there are required
   parameters in its signature.  Likewise, a function can only be
   called with more positional arguments than positional parameters
   (required plus optional) if the function's signature defines a rest
   parameter.

   On the other hand, keyword parameters are always optional.
   Furthermore, CyberLisp does not constrain the allowable keywords
   supplied to a function: even if a function's signature does not
   contain keyword parameters, the call site may still supply keyword
   arguments to the function.  (The function has no means to access
   these spurious arguments, unless it has an all-keys parameter) */

/**** Parameter default value expressions ****/

/* Optional and keyword parameters can have default value expressions,
   that are used when the parameter is not supplied with an argument.
   A default value expression is evaluated in an environment where all
   parameters to the left of it in the parameter list are bound to
   their respective arguments (or default values). */
    
/**** Typed parameters ****/

/* Required, optional, and keyword parameters can be typed.  If an
   argument's type is not a general subtype of a parameter's type, an
   exception is thrown. */
   
/**** Signatures ****/

/* A function's signature ("lambda list") may contain required,
   optional, keyword, rest and all-keys parameters.

   The signature is represented as an object:

   { req_params: <list>,
     opt_params: <list>,
     key_params: <list>,
     rest_param: <param>,
     all_keys_param: <param> }

   req_params, opt_params, key_params: lists of required, optional,
   and keyword parameters, respectively.
   
   rest_param, all_keys_param: the rest and all-keys parameters, or
   null.

   A parameter is also represented as an object:

   { name: <string> }

   name: name of the parameter */

/**** Signature syntax ****/

/* The different kinds of parameters in a function signature are
   introduced by signature keywords: &opt, &key, &rest, and &all-keys.

   For example, a signature with 2 required, 1 optional, and 1 keyword
   argument may look like this:

   (req1 req2 &opt opt1 &key key1)

   All parameters to the right of a signature keyword, and to the left
   of another signature keyword or the end of the signature, belong to
   that kind of parameter.  For example, all parameters to the right
   of an &opt keyword, and to the left of another keyword or the end
   of the list, are optional.  The initial parameters in a signature,
   before any signature keyword appears, are required.
   
   While it's not very useful, it is possible to repeat signature
   keywords, e.g.:

   (&opt opt1 &key key1 &opt opt2 &key key2)

   If a signature contains multiple &rest and &all-keys parameters,
   the leftmost one is used, e.g. in the signature (&rest a b
   &all-keys c d), the parameter `a' is bound to the sequence of
   remaining positional arguments, and the parameter `c' is bound to
   the dictionary of supplied keyword arguments. */

var lisp_optional_sig_keyword = "&opt";
var lisp_key_sig_keyword = "&key";
var lisp_rest_sig_keyword = "&rest";
var lisp_all_keys_sig_keyword = "&all-keys";
var lisp_sig_keywords = 
    [lisp_optional_sig_keyword,
     lisp_key_sig_keyword,
     lisp_rest_sig_keyword,
     lisp_all_keys_sig_keyword];

function lisp_is_sig_keyword(string)
{
    return lisp_array_contains(lisp_sig_keywords, string);
}

/* Given a list of parameter forms, return a signature. */
function lisp_compile_sig(params)
{
    var req = [], opt = [], key = [], rest = [], all_keys = [];
    var cur = req;

    function compile_parameter(param)
    {
        if (param.formt == "symbol") {
            return { name: param.name };
        } else {
            lisp_error("Bad parameter", param);
        }
    }

    for (var i in params) {
        var param = params[i];
        if (param.formt == "symbol") {
            if (lisp_is_sig_keyword(param.name)) {
                switch (param.name) {
                case lisp_optional_sig_keyword: 
                    cur = opt; continue;
                case lisp_key_sig_keyword: 
                    cur = key; continue;
                case lisp_rest_sig_keyword: 
                    cur = rest; continue;
                case lisp_all_keys_sig_keyword: 
                    cur = all_keys; continue;
                }
                lisp_error("Bad signature keyword", param.name);
            }
        }
        cur.push(compile_parameter(param));
    }
    
    return { req_params: req, 
             opt_params: opt, 
             key_params: key, 
             rest_param: rest[0],
             all_keys_param: all_keys[0] };
}

function lisp_param_name(param)
{
    return lisp_assert_nonempty_string(param.name);
}

function lisp_mangled_param_name(param)
{
    return lisp_mangle_var(lisp_param_name(param));
}

/**** Function call sites ****/

/* At a function call site, keyword arguments are apparent at
   compile-time.  For example, in the call `(foo file: f 12)', there
   is one keyword argument named `file' with the value `f' and one
   positional argument with the value `12'.

   A call site is represented as an object:

   { pos_args: <list>, 
     key_args: <dict> }

   pos_args: list of VOPs of positional arguments;

   key_args: dictionary that maps mangled keyword argument names
   (without the trailing ":") to their value VOPs.  Mangling
   (specifically, prefixing) is necessary, or otherwise the keyword
   names could conflict with JavaScript's special properties
   (e.g. prototype). */

function lisp_is_keyword_arg(string)
{
    if (string.length > 1)
        return string[string.length - 1] == ":";
    else
        return false;
}

function lisp_clean_keyword_arg(string)
{
    return string.slice(0, string.length - 1);
}

/* Given a list of argument forms, return a call site. */
function lisp_compile_call_site(args)
{
    var pos_args = [];
    var key_args = {};
    
    for (var i = 0; i < args.length; i++) {
        var arg = args[i];
        if (arg.formt == "symbol") {
            if (lisp_is_keyword_arg(arg.name)) {
                var name = lisp_clean_keyword_arg(arg.name);
                var value = lisp_compile(args[++i]);
                key_args[lisp_mangle_keyword_arg(name)] = value;
                continue;
            }
        }
        pos_args.push(lisp_compile(arg));
    }

    return { pos_args: pos_args,
             key_args: key_args };
}

/**** Calling convention ****/

/* Given that we can statically determine positional and keyword
   arguments at a call site (see above), we can implement a calling
   convention that, for calls with only required arguments, is as fast
   as a normal JavaScript call.
   
   All functions get a hidden calling convention parameter as first
   parameter.  This parameter is a dictionary that maps the names of
   keyword arguments to their value VOPs.  The names of the keyword
   arguments do not contain the trailing ":" and they are mangled.
   After the keywords dictionary, the positional arguments are passed
   as normal JavaScript arguments.

   See `lisp_emit_vop_funcall' and `lisp_emit_vop_lambda', below, for
   the implementation of the caller and callee sides of the calling
   convention, respectively. */

// Name of the calling convention parameter.
var lisp_keywords_dict = "_key_";


/*** Quasiquotation ***/

/* A quasiquote form is compiled into code that, when evaluated,
   produces a form.  No, really, I couldn't believe it myself.

   Except for not allowing multi-argument unquotes, this algorithm
   should be equal to the one in Appendix B of Alan Bawden's paper
   "Quasiquotation in LISP", 1999. */

function lisp_compile_qq(x, depth)
{
    if (depth < 0) 
        lisp_error("Negative quasiquotation nesting depth", x);

    switch(x.formt) {
    case "number":
    case "symbol":
    case "string":
        return { vopt: "quote", form: x };
    case "compound":
        return lisp_compile_qq_compound(x, depth);
    }

    lisp_error("Bad quasiquoted form", x);
}

function lisp_compile_qq_compound(x, depth)
{
    var op = x.elts[0];
    if (op) {
        if (is_unquote(op)) {
            if (depth == 0) {
                return lisp_compile(x.elts[1]);
            } else {
                return unquote(x.elts[1], depth - 1);
            }
        } else if (is_quasiquote(op)) {
            return quasiquote(x.elts[1], depth + 1);
        } else {
            return compile_compound(x, depth);
        }
    } else {
        return make_compound([]);
    }

    function compile_compound(x, depth)
    {
        var compounds = [], compound_elts = [];
        for (var i in x.elts) {
            var sub = x.elts[i];
            if ((sub.formt == "compound") && is_unquote_splicing(sub.elts[0])) {
                compounds.push(make_compound(compound_elts));
                compound_elts = [];
                if (depth == 0) {
                    compounds.push(lisp_compile(sub.elts[1]));
                } else {
                    compounds.push(unquote_splicing(sub.elts[1], depth - 1));
                }
            } else {
                compound_elts.push(lisp_compile_qq(sub, depth));
            }
        }
        if (compound_elts.length > 0) 
            compounds.push(make_compound(compound_elts));
        return append_compounds(compounds);
    }

    function is_quasiquote(op)
    {
        return op && (op.formt == "symbol") && (op.name == "%%quasiquote");
    }

    function is_unquote(op)
    {
        return op && (op.formt == "symbol") && (op.name == "%%unquote");
    }

    function is_unquote_splicing(op)
    {
        return op && (op.formt == "symbol") && (op.name == "%%unquote-splicing");
    }

    function quasiquote(x, depth)
    {
        return compound([quote(symbol("%%quasiquote")), 
                         lisp_compile_qq(x, depth)]);
    }

    function unquote(x, depth)
    {
        return compound([quote(symbol("%%unquote")), 
                         lisp_compile_qq(x, depth)]);
    }

    function unquote_splicing(x, depth)
    {
        return compound([quote(symbol("%%unquote-splicing")), 
                         lisp_compile_qq(x, depth)]);
    }

    function make_compound(elt_vops)
    {
        return { vopt: "funcall",
                 fun: { vopt: "fref", name: "%%make-compound" },
                 call_site: { pos_args: elt_vops } };
    }

    function append_compounds(elt_vops)
    {
        return { vopt: "funcall",
                 fun: { vopt: "fref", name: "%%append-compounds" },
                 call_site: { pos_args: elt_vops } };
    }

    function symbol(name)
    {
        return { formt: "symbol", name: name };
    }

    function quote(form)
    {
        return { vopt: "quote", form: form };
    }
}

function lisp_make_compound(_key_)
{
    var elts = [];
    for (var i = 1; i < arguments.length; i++) {
        elts = elts.concat(arguments[i]);
    }
    return { formt: "compound", elts: elts };
}

function lisp_append_compounds(_key_)
{
    var elts = [];
    for (var i = 1; i < arguments.length; i++) {
        lisp_assert(arguments[i].formt == "compound");
        elts = elts.concat(arguments[i].elts);
    }
    return { formt: "compound", elts: elts };    
}


/*** Virtual Operations ***/

/* Virtual operations (VOPs) are low-level operations that are emitted
   to JavaScript. */

function lisp_emit(vop)
{
    // Emits a VOP to JavaScript.
    lisp_assert_string(vop.vopt, "Bad .vopt", vop);
    var vop_function = lisp_vop_function(vop.vopt);
    lisp_assert_not_null(vop_function, "No VOP emitter function", vop);
    return vop_function(vop);
}

function lisp_vop_function(vopt)
{
    // Returns the VOP emitter function for a VOP, or null.
    return lisp_vop_table[vopt];
}

/**** List of VOPs ****/

var lisp_vop_table = {
    "fref": lisp_emit_vop_fref,
    "fset": lisp_emit_vop_fset,
    "funcall": lisp_emit_vop_funcall,
    "lambda": lisp_emit_vop_lambda,
    "macroset": lisp_emit_vop_macroset,
    "number": lisp_emit_vop_number,
    "progn": lisp_emit_vop_progn,
    "quote": lisp_emit_vop_quote,
    "ref": lisp_emit_vop_ref,
    "set": lisp_emit_vop_set,
    "string": lisp_emit_vop_string,
};

/* Function reference. 
   { vopt: "fref", name: <string> }
   name: the name of the function. */
function lisp_emit_vop_fref(vop)
{
    var name = lisp_assert_nonempty_string(vop.name, "Bad function", vop);
    return lisp_mangle_function(name);
}

/* Assigns a value to a function.
   { vopt: "fset", name: <string>, value: <vop> }
   name: the name of the function;
   value: VOP for the value. */
function lisp_emit_vop_fset(vop)
{
    var name = lisp_assert_nonempty_string(vop.name, "Bad function", vop);
    var value = lisp_assert_not_null(vop.value, "Bad value", vop);
    return "(" + lisp_mangle_function(name) + " = " + lisp_emit(value) + ")";
}

/* Calls a function.
   { vopt: "funcall", fun: <vop>, call_site: <call_site> }
   fun: VOP of the function;
   call_site: positional and keyword argument VOPs (see above). */
function lisp_emit_vop_funcall(vop)
{
    var fun = lisp_assert_not_null(vop.fun, "Bad function", vop);
    var call_site = lisp_assert_not_null(vop.call_site, "Bad call site", vop);

    function emit_key_args(key_args)
    {
        var s = "{ ";
        for (var k in key_args) {
            var v = lisp_assert_not_null(key_args[k]);
            s += k + ": " + lisp_emit(v);
        }
        return s + " }";
    }

    var keywords_dict = emit_key_args(call_site.key_args);
    var pos_args = call_site.pos_args.map(lisp_emit);
    var args = [ keywords_dict ].concat(pos_args).join(", ");

    return "(" + lisp_emit(fun) + "(" + args + "))";
}

/* Creates a lexical closure.
   { vopt: "lambda", sig: <sig>, body: <vop> }
   sig: signature, see above;
   body: VOP for the function's body. */
function lisp_emit_vop_lambda(vop)
{
    var req_params = lisp_assert_not_null(vop.sig.req_params);
    var opt_params = lisp_assert_not_null(vop.sig.opt_params);
    var rest_param = vop.sig.rest_param;

    // Signature (calling convention keywords dict + positional parameters)
    var param_names = [ lisp_keywords_dict ];
    param_names = param_names.concat(req_params.map(lisp_mangled_param_name));
    param_names = param_names.concat(opt_params.map(lisp_mangled_param_name));
    var sig = param_names.join(", ");

    // Positional arguments arity check
    var min = 1 + req_params.length;
    if (!rest_param) {
        var max = 1 + req_params.length + opt_params.length;
        var arity_check = 
            "lisp_arity_min_max(arguments.length, " + min + ", " + max + ")";
    } else {
        var arity_check = 
            "lisp_arity_min(arguments.length, " + min + ")";
    }

    var preamble = arity_check;
    var body = preamble + ", " + lisp_emit(vop.body);
    return "(function(" + sig + "){ return (" + body + "); })";
}

/* { vopt: "macroset", name: <string>, expander: <vop> }
   name: macro's name;
   expander: VOP for expander function. */
function lisp_emit_vop_macroset(vop)
{
    var name = lisp_assert_nonempty_string(vop.name);
    var expander = lisp_assert_not_null(vop.expander);
    return "(lisp_set_macro_function(\"" + name + "\", " + lisp_emit(expander) + "))";
}

/* Number literal.
   { vopt: "number", n: <string> }
   n: the number in JavaScript syntax. */
function lisp_emit_vop_number(vop)
{
    lisp_assert_nonempty_string(vop.n, "Bad .n", vop);
    lisp_assert_number(eval(vop.n), "Bad number", vop);
    return vop.n;
}

/* Evaluates a number of VOPs in sequence and returns the value of the last.
   { vopt: "progn", vops: <list> } 
   vops: list of VOPs. */
function lisp_emit_vop_progn(vop)
{
    lisp_assert_not_null(vop.vops, "Bad PROGN", vop);
    if (vop.vops.length > 0)
        return "(" + vop.vops.map(lisp_emit).join(", ") + ")";
    else
        return "null";
}

/* Evaluates to the form itself.
   { vopt: "quote", form: <form> }
   form: any form. */
function lisp_emit_vop_quote(vop)
{
    return JSON.stringify(vop.form);
}

/* Variable reference.
   { vopt: "ref", name: <string> }
   name: the name of the variable. */
function lisp_emit_vop_ref(vop)
{
    lisp_assert_nonempty_string(vop.name, "Bad variable name", vop);
    return lisp_mangle_var(vop.name);
}

/* Assigns a value to a variable.
   { vopt: "set", name: <string>, value: <vop> }
   name: the name of the variable;
   value: VOP for the value. */
function lisp_emit_vop_set(vop)
{
    var name = lisp_assert_nonempty_string(vop.name, "Bad variable name", vop);
    var value = lisp_emit(vop.value);
    return "(" + lisp_mangle_var(name) + " = " + value + ")";
}

/* String literal.
   { vopt: "string", s: <string> }
   s: the string in JavaScript syntax. */
function lisp_emit_vop_string(vop)
{
    lisp_assert_string(vop.s, "Bad .s", vop);
    return JSON.stringify(vop.s);
}


/*** Name Mangling ***/

/* Lisp symbols may contain additional characters beyond those
   supported by JavaScript names.  These special characters are
   translated to uppercase characters, which are not allowed in
   CyberLisp symbols. */

// Needs to be in sync with `lisp_symbol_special_char'.
var lisp_mangle_table = 
    [
     ["&", "A"],
     [":", "C"],
     [".", "D"],
     ["=", "E"],
     [">", "G"],
     ["-", "H"],
     ["<", "L"],
     ["%", "N"],
     ["+", "P"],
     ["/", "S"],
     ["*", "T"],
     ];

function lisp_mangle(name)
{
    lisp_assert_nonempty_string(name, "Bad name", name);
    for (var i in lisp_mangle_table) {
        var pair = lisp_mangle_table[i];
        var pattern = new RegExp("\\" + pair[0], "g");
        name = name.replace(pattern, pair[1]);
    }
    return name;
}

/* Additionally, the different namespaces (variable, function, slot,
   method) are prefixed, so they can coexist in their respective
   JavaScript namespace(s). */

function lisp_mangle_var(name)
{
    return "_v_" + lisp_mangle(name);
}

function lisp_mangle_function(name)
{
    return "_f_" + lisp_mangle(name);
}

function lisp_mangle_slot(name)
{
    return "_s_" + lisp_mangle(name);
}

function lisp_mangle_method(name)
{
    return "_m_" + lisp_mangle(name);
}

function lisp_mangle_keyword_arg(name)
{
    return "_k_" + lisp_mangle(name);
}


/*** Utilities ***/

function lisp_fset(lisp_name, js_function)
{
    eval(lisp_mangle_function(lisp_name) + " = " + js_function);
}

function lisp_show(obj)
{
    return JSON.stringify(obj);
}

function lisp_array_contains(array, elt)
{
    for (var i in array) {
        if (array[i] == elt) return true;
    }
    return false;
}

function lisp_error(message, arg)
{
    throw Error(message + ": " + lisp_show(arg));
}

function lisp_assert(value, message, arg)
{
    if (!value) lisp_error(message, arg);
    return value;
}

function lisp_assert_not_null(value, message, arg)
{
    lisp_assert(value != null, message, arg);
    return value;
}

function lisp_assert_number(value, message, arg)
{
    lisp_assert(typeof value == "number", message, arg);
    return value;
}

function lisp_assert_string(value, message, arg)
{
    lisp_assert(typeof value == "string", message, arg);
    return value;
}

function lisp_assert_nonempty_string(value, message, arg)
{
    lisp_assert_string(value, message, arg);
    lisp_assert(value.length > 0, message, arg);
    return value;
}

function lisp_assert_function(value, message, arg)
{
    lisp_assert(typeof value == "function", message, arg);
    return value;
}

function lisp_assert_symbol_form(value, message, arg)
{
    lisp_assert(typeof value == "object", message, arg);
    lisp_assert(value.formt == "symbol", message, arg);
    lisp_assert_nonempty_string(value.name, message, arg);
    return value;
}

function lisp_assert_compound_form(value, message, arg)
{
    lisp_assert(typeof value == "object", message, arg);
    lisp_assert(value.formt == "compound", message, arg);
    lisp_assert_not_null(value.elts, message, arg);
    lisp_assert_not_null(value.elts.length, message, arg);
    return value;
}

/**** Define built-in functions ****/

lisp_fset("%%make-compound", "lisp_make_compound");
lisp_fset("%%append-compounds", "lisp_append_compounds");